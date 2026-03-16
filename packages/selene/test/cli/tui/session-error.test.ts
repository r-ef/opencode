import { describe, expect, test } from "bun:test"
import { formatSessionError } from "../../../src/cli/cmd/tui/util/session-error"

describe("tui session error formatting", () => {
  test("surfaces provider status and url for api errors", () => {
    expect(
      formatSessionError({
        name: "APIError",
        data: {
          message: "Provider error 400 Bad Request: Structured output is not supported for this model.",
          statusCode: 400,
          responseBody: '{"error":{"message":"Structured output is not supported for this model."}}',
          metadata: {
            url: "https://example.com/v1/chat",
          },
        },
      }),
    ).toEqual([
      "Provider error 400 Bad Request: Structured output is not supported for this model.",
      "status 400",
      "https://example.com/v1/chat",
    ])
  })

  test("passes through non-api errors without extra lines", () => {
    expect(
      formatSessionError({
        name: "UnknownError",
        data: {
          message: "boom",
        },
      }),
    ).toEqual(["boom"])
  })

  test("shows raw response body when provider message stays generic", () => {
    expect(
      formatSessionError({
        name: "APIError",
        data: {
          message: "Provider error 400 Bad Request: Provider returned error",
          statusCode: 400,
          responseBody: '{"error":{"code":"unsupported","detail":"tools not supported"}}',
          metadata: {
            url: "https://example.com/v1/chat",
          },
        },
      }),
    ).toEqual([
      "Provider error 400 Bad Request: Provider returned error",
      "status 400",
      "https://example.com/v1/chat",
      'body {"error":{"code":"unsupported","detail":"tools not supported"}}',
    ])
  })
})
