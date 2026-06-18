// Type declarations for Entry (playentry.org) global object
declare interface EntryVariable {
  name_: string;
  id_: string;
  value_: string | number;
  type: string;
  object_: string | null;
  isCloud_: boolean;
  isRealTime_: boolean;
  setValue(value: unknown): void;
  getValue(): unknown;
  getName(): string;
  setName(name: string): void;
  toJSON(): Record<string, unknown>;
}

declare interface EntryListVariable extends EntryVariable {
  array_: Array<{ data: unknown }>;
  setArray(array: unknown[]): void;
  appendValue(value: unknown): void;
  deleteValue(index: number): void;
  insertValue(index: number, data: unknown): void;
  replaceValue(index: number, data: unknown): void;
  getArray(): Array<{ data: unknown }>;
}

declare interface EntryVariableContainer {
  variables_: EntryVariable[];
  lists_: EntryListVariable[];
  messages_: unknown[];
}

declare interface EntryBlock {
  type: string;
  id: string;
  params: unknown[];
  thread?: any;
  getSchema(): any;
  getNextBlock(): EntryBlock | null;
}

declare interface EntryStatic {
  Variable: {
    new (metadata: Record<string, unknown>): EntryVariable;
    prototype: EntryVariable;
    create(metadata: Record<string, unknown>): EntryVariable;
  };
  ListVariable: {
    new (metadata: Record<string, unknown>): EntryListVariable;
    prototype: EntryListVariable;
  };
  variableContainer: EntryVariableContainer;
  addEventListener(event: string, callback: () => void): void;
  dispatchEvent(event: string, data?: unknown): void;
  addEventListener(event: 'blockExecute', callback: (blockView: any) => void): void;
  removeEventListener(event: 'blockExecute', callback: (blockView: any) => void): void;
}

declare interface Window {
  Entry: EntryStatic;
}
