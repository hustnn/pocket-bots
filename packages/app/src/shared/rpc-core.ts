import type { z, ZodType } from "zod";

// A typed request/response pair between the web UI and the server: both sides
// import one contract and validate against it.
// The server serves them at POST /api/rpc/<name>.

export interface RpcContract<Input extends ZodType = ZodType, Output extends ZodType = ZodType> {
  name: string;
  input: Input;
  output: Output;
}

export type RpcInput<C extends RpcContract> = z.input<C["input"]>;
export type RpcOutput<C extends RpcContract> = z.output<C["output"]>;

const RPC_NAME = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

export function defineRpc<Input extends ZodType, Output extends ZodType>(contract: RpcContract<Input, Output>): RpcContract<Input, Output> {
  if (!RPC_NAME.test(contract.name)) throw new Error(`Invalid RPC name: ${contract.name}`);
  return contract;
}
