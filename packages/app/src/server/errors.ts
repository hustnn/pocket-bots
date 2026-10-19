/**
 * The caller asked for something that can't be done as asked (a message that isn't there, a group
 * with one bot, a value out of range): its message says what to change. The RPC answers it with
 * HTTP 400; any other error is a failure of ours and answers 500. A bot's tool call shows the
 * message either way.
 */
export class RequestError extends Error {
  override name = "RequestError";
}
