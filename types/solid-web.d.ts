import "solid-js/web"

declare module "solid-js/web" {
  interface RequestEvent {
    response: Response
    locals: Record<string | number | symbol, unknown>
    params: Record<string, string>
  }
}
