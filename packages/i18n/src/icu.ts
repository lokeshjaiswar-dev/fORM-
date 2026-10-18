import { TYPE, parse, type MessageFormatElement } from '@formatjs/icu-messageformat-parser';

export interface ParsedMessage {
  ast: MessageFormatElement[];
  /** Every argument the message reads, in first-use order. */
  args: readonly string[];
}

function collect(elements: readonly MessageFormatElement[], args: Set<string>): void {
  for (const element of elements) {
    switch (element.type) {
      case TYPE.argument:
        args.add(element.value);
        break;
      case TYPE.number:
        if (element.style) {
          throw new Error(`{${element.value}, number, …}: number styles and skeletons are not supported; use {${element.value}, number} or a value from formatNumber/formatMoney`);
        }
        args.add(element.value);
        break;
      case TYPE.date:
      case TYPE.time:
        throw new Error(`{${element.value}, ${element.type === TYPE.date ? 'date' : 'time'}}: date and time arguments are not supported; pass a value from formatDate/formatTime`);
      case TYPE.plural:
      case TYPE.select:
        args.add(element.value);
        for (const option of Object.values(element.options)) collect(option.value, args);
        break;
      case TYPE.tag:
        collect(element.children, args);
        break;
      default:
        break;
    }
  }
}

/**
 * Parses an ICU MessageFormat source and rejects anything that would format through the host's
 * Intl data (date, time, number styles and skeletons), so every message renders the same everywhere.
 * Throws an `Error` describing the first problem.
 */
export function parseMessage(source: string): ParsedMessage {
  const ast = parse(source, { ignoreTag: true, requiresOtherClause: true });
  const args = new Set<string>();
  collect(ast, args);
  return { ast, args: [...args] };
}
