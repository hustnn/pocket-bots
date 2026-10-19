import type { RpcContract, RpcInput, RpcOutput } from "../../shared/rpc-core";

export class RpcError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/** Calls one of the server's RPCs (POST /api/rpc/<name>). */
export async function rpc<C extends RpcContract>(contract: C, input: RpcInput<C>): Promise<RpcOutput<C>> {
  const response = await fetch(`/api/rpc/${contract.name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input ?? {}),
  });
  let body: { data?: unknown; error?: string };
  try {
    body = (await response.json()) as { data?: unknown; error?: string };
  } catch {
    throw new RpcError(`The server answered ${response.status}.`, response.status);
  }
  if (!response.ok || body.error) throw new RpcError(body.error ?? `The server answered ${response.status}.`, response.status);
  return body.data as RpcOutput<C>;
}

export function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
