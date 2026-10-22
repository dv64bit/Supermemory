import { expect, test } from "bun:test";
import { parseSse } from "../src/api";

test("parseSse reads event + JSON data, tolerates CRLF-free multi-line data and junk", () => {
  expect(parseSse('event: delta\ndata: {"text":"hi"}')).toEqual({ event: "delta", data: { text: "hi" } } as never);
  expect(parseSse('event: context\ndata: {"conversationId":"c1",\ndata: "memories":[]}')).toEqual({
    event: "context",
    data: { conversationId: "c1", memories: [] },
  } as never);
  expect(parseSse(": keep-alive comment")).toBeNull();
  expect(parseSse("event: delta\ndata: not json")).toBeNull();
});
