type Params = Record<string, string>
type Locals = Record<string | number | symbol, unknown>

interface EventShape {
  request: Request
  response: Response
  locals: Locals
  params: Params
}

interface Session<T> {
  data: T
  update(fn: (data: T) => T | Promise<T>): Promise<void>
}

declare module "@solidjs/start" {
  export interface APIEvent extends EventShape {}

  export const HttpStatusCode: import("solid-js").Component<{ code: number }>

  export function clientOnly<P = Record<string, never>>(
    load: () => Promise<{ default: import("solid-js").Component<P> }>,
    opts?: Record<string, unknown>,
  ): import("solid-js").Component<P>
}

declare module "@solidjs/start/router" {
  export const FileRoutes: import("solid-js").Component
}

declare module "@solidjs/start/client" {
  export const StartClient: import("solid-js").Component

  export function mount(fn: () => import("solid-js").JSX.Element, el: Element): void
}

declare module "@solidjs/start/server" {
  export interface APIEvent extends EventShape {}

  export const StartServer: import("solid-js").Component<{
    document?: (props: {
      assets?: import("solid-js").JSX.Element
      children?: import("solid-js").JSX.Element
      scripts?: import("solid-js").JSX.Element
    }) => import("solid-js").JSX.Element
  }>

  export function createHandler(
    fn: () => import("solid-js").JSX.Element,
    opts?: Record<string, unknown>,
  ): unknown
}

declare module "@solidjs/start/config" {
  export function solidStart(opts?: Record<string, unknown>): import("vite").PluginOption
}

declare module "@solidjs/start/middleware" {
  export function createMiddleware<T extends { onRequest?: (event: EventShape) => unknown }>(cfg: T): T
}

declare module "@solidjs/start/http" {
  export function useSession<T>(opts: {
    password: string
    name: string
    maxAge?: number
    cookie?: {
      secure?: boolean
      httpOnly?: boolean
    }
  }): Promise<Session<T>>
}
