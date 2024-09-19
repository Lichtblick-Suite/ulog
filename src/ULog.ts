import { ChunkedReader } from "./ChunkedReader";
import {
  Field,
  MessageDefinition,
  parseFieldDefinition,
  parseMessageDefinition,
} from "./definition";
import { MessageType } from "./enums";
import { Filelike } from "./file";
import { findRange } from "./findRange";
import { toHex } from "./hex";
import {
  MessageFlagBits,
  MessageAddLogged,
  DataSectionMessage,
  FieldPrimitive,
  MessageDataParsed,
} from "./messages";
import { parseBasicFieldValue, parseMessage } from "./parse";
import { readRawMessage } from "./readMessage";

export type ParameterEntry = { value: number; defaultTypes: number };

export type ULogHeader = {
  version: number;
  timestamp: bigint; // [μs]
  flagBits?: MessageFlagBits;
  information: Map<string, FieldPrimitive | FieldPrimitive[]>;
  parameters: Map<string, ParameterEntry>;
  definitions: Map<string, MessageDefinition>;
};

const MAGIC = [0x55, 0x4c, 0x6f, 0x67, 0x01, 0x12, 0x35];

type IndexEntry = [timestamp: bigint, logPosition: number, messae: DataSectionMessage];

export class ULog {
  #reader: ChunkedReader;

  // These members are only populated after open()
  #dataStart?: number;
  #dataEnd?: number;
  #header?: ULogHeader;
  #appendedOffsets?: [number, number, number];
  #subscriptions = new Map<number, MessageDefinition>();
  #timeIndex?: IndexEntry[];
  #dataMessageCounts?: Map<number, number>;
  #logMessageCount?: number;

  constructor(filelike: Filelike, opts: { chunkSize?: number } = {}) {
    this.#reader = new ChunkedReader(filelike, opts.chunkSize);
  }

  get header(): ULogHeader | undefined {
    return this.#header;
  }

  get subscriptions(): Map<number, MessageDefinition> {
    return this.#subscriptions;
  }

  async open(): Promise<void> {
    await this.#reader.open();
    const data = await this.#reader.readBytes(8);
    for (let i = 0; i < MAGIC.length; i++) {
      if (data[i] !== MAGIC[i]) {
        throw new Error(`Invalid ULog header: ${toHex(data)}`);
      }
    }

    const version = data[7]!;
    const timestamp = await this.#reader.readUint64();
    const information = new Map<string, FieldPrimitive | FieldPrimitive[]>();
    const parameters = new Map<string, ParameterEntry>();
    const definitions = new Map<string, MessageDefinition>();

    let flagBits: MessageFlagBits | undefined;
    while (!(await isDataSectionStart(this.#reader))) {
      const message = await readRawMessage(this.#reader, this.#dataEnd);
      if (!message) {
        break;
      }

      switch (message.type) {
        case MessageType.FlagBits: {
          flagBits = message;
          break;
        }
        case MessageType.Information: {
          const infoMsg = message;
          const field = parseFieldDefinition(infoMsg.key);
          if (isValidInfoField(field)) {
            const value = infoMsg.value;
            const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
            const parsed = parseBasicFieldValue(field, view);
            information.set(field.name, parsed);
          }
          break;
        }
        case MessageType.InformationMulti: {
          const infoMultiMsg = message;
          const field = parseFieldDefinition(infoMultiMsg.key);
          if (isValidInfoField(field)) {
            let array = information.get(infoMultiMsg.key) as FieldPrimitive[] | undefined;
            if (!Array.isArray(array)) {
              array = [];
              information.set(infoMultiMsg.key, array);
            }

            const value = infoMultiMsg.value;
            const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
            const parsed = parseBasicFieldValue(field, view);
            array.push(parsed);
          }
          break;
        }
        case MessageType.FormatDefinition: {
          const formatMsg = message;
          const msgdef = parseMessageDefinition(formatMsg.format);
          if (msgdef) {
            definitions.set(msgdef.name, msgdef);
          } else {
            throw new Error(`oops: ${formatMsg.format}`);
          }
          break;
        }
        case MessageType.Parameter: {
          const paramMsg = message;
          const field = parseFieldDefinition(paramMsg.key);
          if (isValidParameter(field)) {
            const value = paramMsg.value;
            const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
            const parsed = parseBasicFieldValue(field, view);
            parameters.set(field.name, { value: parsed as number, defaultTypes: 0 });
          }
          break;
        }
        case MessageType.ParameterDefault: {
          const paramMsg = message;
          const field = parseFieldDefinition(paramMsg.key);
          if (isValidParameter(field)) {
            const value = paramMsg.value;
            const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
            const parsed = parseBasicFieldValue(field, view) as number | undefined;
            if (parsed != undefined) {
              parameters.set(field.name, { value: parsed, defaultTypes: paramMsg.defaultTypes });
            }
          }
          break;
        }
        default:
          throw new Error(`Unrecognized message type ${message.type}`);
      }
    }

    // File offsets are stored as 64-bit unsigned integers, but we cast to Number here which safely
    // stores up to 53-bit integers. This supports ulogs up to 8192 TB in length
    const appendedOffsets = flagBits?.appendedOffsets ?? [0n, 0n, 0n];
    this.#appendedOffsets = appendedOffsets.map((n) => Number(n)) as [number, number, number];
    const firstOffset = this.#appendedOffsets[0];

    this.#dataStart = this.#reader.position();
    this.#dataEnd = this.#reader.size();
    if (firstOffset > 0 && firstOffset < this.#dataEnd) {
      this.#dataEnd = firstOffset;
    }

    this.#header = { version, timestamp, flagBits, information, parameters, definitions };

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (this.#dataStart == undefined || this.#dataEnd == undefined) {
      throw new Error(`Cannot create index before open`);
    }

    await this.#createIndex();
  }

  async *readMessages(
    opts: { startTime?: bigint; endTime?: bigint } = {},
  ): AsyncIterableIterator<DataSectionMessage> {
    const sortedMessages = this.#timeIndex;
    if (sortedMessages == undefined) {
      throw new Error(`Cannot readMessages before createIndex`);
    }

    if (sortedMessages.length === 0) {
      return;
    }

    const startTime = opts.startTime ?? sortedMessages[0]![0];
    const endTime = opts.endTime ?? sortedMessages[sortedMessages.length - 1]![0];

    const range = findRange(sortedMessages, startTime, endTime);
    if (range == undefined) {
      return;
    }

    for (let i = range[0]; i <= range[1]; i++) {
      yield sortedMessages[i]![2];
    }
  }

  messageCount(): number | undefined {
    return this.#timeIndex?.length;
  }

  dataMessageCounts(): ReadonlyMap<number, number> | undefined {
    return this.#dataMessageCounts;
  }

  logCount(): number | undefined {
    return this.#logMessageCount;
  }

  timeRange(): Readonly<[bigint, bigint]> | undefined {
    if (!this.#timeIndex || this.#timeIndex.length === 0) {
      return undefined;
    }
    const start = this.#timeIndex[0]![0];
    const end = this.#timeIndex[this.#timeIndex.length - 1]![0];
    return [start, end];
  }

  async #createIndex(): Promise<void> {
    const timeIndex: IndexEntry[] = [];
    const dataCounts = new Map<number, number>();
    let maxTimestamp = 0n;
    let logMessageCount = 0;

    let i = 0;
    let message: DataSectionMessage | undefined;
    while ((message = await this.#readParsedMessage())) {
      if (message.type === MessageType.Data) {
        if (message.value.timestamp > maxTimestamp) {
          maxTimestamp = message.value.timestamp;
        }
        timeIndex.push([message.value.timestamp, i++, message]);
        dataCounts.set(message.msgId, (dataCounts.get(message.msgId) ?? 0) + 1);
      } else if (message.type === MessageType.Log || message.type === MessageType.LogTagged) {
        if (message.timestamp > maxTimestamp) {
          maxTimestamp = message.timestamp;
        }
        timeIndex.push([message.timestamp, i++, message]);
        logMessageCount++;
      } else {
        timeIndex.push([maxTimestamp, i++, message]);
      }
    }

    this.#timeIndex = timeIndex.sort(sortTimeIndex);
    this.#dataMessageCounts = dataCounts;
    this.#logMessageCount = logMessageCount;
  }

  async #readParsedMessage(): Promise<DataSectionMessage | undefined> {
    if (!this.#header) {
      throw new Error(`Cannot read before open`);
    }

    const rawMessage = await readRawMessage(this.#reader, this.#dataEnd);
    if (!rawMessage) {
      return undefined;
    }

    if (rawMessage.type === MessageType.AddLogged) {
      this.#handleSubscription(rawMessage);
    }

    if (rawMessage.type !== MessageType.Data) {
      return rawMessage as DataSectionMessage;
    }

    const dataMsg = rawMessage;
    const definition = this.#subscriptions.get(dataMsg.msgId);
    if (!definition) {
      const msgPos = this.#reader.position() - rawMessage.size - 3;
      throw new Error(
        `Unknown msg_id ${dataMsg.msgId} for ${rawMessage.size} byte 'D' message at offset ${msgPos}`,
      );
    }

    const data = dataMsg.data;
    const value = parseMessage(
      definition,
      this.#header.definitions,
      this.#reader.view()!,
      data.byteOffset,
    );
    const parsed: MessageDataParsed = {
      size: dataMsg.size,
      type: MessageType.Data,
      msgId: dataMsg.msgId,
      data,
      value,
    };
    return parsed;
  }

  #handleSubscription(subscribe: MessageAddLogged): void {
    const definition = this.#header?.definitions.get(subscribe.messageName);
    if (!definition) {
      throw new Error(`AddLogged unknown message_name: ${subscribe.messageName}`);
    }
    this.#subscriptions.set(subscribe.msgId, definition);
  }
}

async function isDataSectionStart(reader: ChunkedReader): Promise<boolean> {
  const type = await reader.peekUint8(2);
  switch (type) {
    case MessageType.AddLogged:
    case MessageType.RemoveLogged:
    case MessageType.Data:
    case MessageType.Log:
    case MessageType.LogTagged:
    case MessageType.Synchronization:
    case MessageType.Dropout:
      return true;
    default:
      return false;
  }
}

function isValidInfoField(field: Field | undefined): field is Field {
  return field?.isComplex === false;
}

function isValidParameter(field: Field | undefined): field is Field {
  return Boolean(
    field && (field.type === "int32_t" || field.type === "float") && field.arrayLength == undefined,
  );
}

function sortTimeIndex(a: IndexEntry, b: IndexEntry) {
  const timestampA = a[0];
  const timestampB = b[0];
  if (timestampA === timestampB) {
    const indexA = a[1];
    const indexB = b[1];
    return indexA - indexB;
  }
  return Number(timestampA - timestampB);
}
