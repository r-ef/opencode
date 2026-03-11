declare module "ghostty-web" {
  export interface IBufferCell {
    getChars(): string
    getCode(): number
    getWidth(): number
    getFgColorMode(): number
    getBgColorMode(): number
    getFgColor(): number
    getBgColor(): number
    isBold(): number
    isItalic(): number
    isUnderline(): number
    isStrikethrough(): number
    isBlink(): number
    isInverse(): number
    isInvisible(): number
    isFaint(): number
    isDim(): boolean
  }

  export interface IBufferLine {
    readonly length: number
    readonly isWrapped: boolean
    getCell(x: number): IBufferCell | undefined
    translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string
  }

  export interface IBuffer {
    readonly type: "normal" | "alternate"
    readonly cursorX: number
    readonly cursorY: number
    readonly viewportY: number
    readonly baseY: number
    readonly length: number
    getLine(y: number): IBufferLine | undefined
    getNullCell(): IBufferCell
  }

  export interface IBufferRange {
    start: {
      x: number
      y: number
    }
    end: {
      x: number
      y: number
    }
  }

  export interface ITerminalCore {
    buffer: {
      active: IBuffer
      normal?: IBuffer
      alternate?: IBuffer
    }
    rows: number
    cols: number
  }

  export interface ITerminalAddon {
    activate(terminal: ITerminalCore): void
    dispose?(): void
  }

  export interface FitAddon {
    fit(): void
    observeResize(): void
    dispose(): void
  }

  export interface Ghostty {
    // runtime instance placeholder
  }

  export const Ghostty: {
    load(): Promise<Ghostty>
  }

  export class FitAddon {
    fit(): void
    observeResize(): void
    dispose(): void
  }

  export class Terminal implements ITerminalCore {
    buffer: {
      active: IBuffer
      normal?: IBuffer
      alternate?: IBuffer
    }
    rows: number
    cols: number
    textarea?: HTMLTextAreaElement
    options: {
      cursorBlink?: boolean
    }

    constructor(opts?: {
      cursorBlink?: boolean
      cursorStyle?: string
      cols?: number
      rows?: number
      fontSize?: number
      fontFamily?: string
      allowTransparency?: boolean
      convertEol?: boolean
      theme?: Record<string, string>
      scrollback?: number
      ghostty?: Ghostty
    })

    attachCustomKeyEventHandler(fn: (event: KeyboardEvent) => boolean): void
    dispose(): void
    focus(): void
    getSelection(): string
    getViewportY(): number
    loadAddon(addon: ITerminalAddon | FitAddon): void
    onData(fn: (data: string) => void): { dispose(): void }
    onKey(fn: (key: { key: string }) => void): { dispose(): void }
    onResize(fn: (size: { cols: number; rows: number }) => void): { dispose(): void }
    open(node: Element): void
    paste(data: string): void
    reset(): void
    scrollToLine(line: number): void
    write(data: string, done?: () => void): void
  }
}
