import { createConfig } from "ponder-rise";
import { erc20Abi } from "viem";
import { riseTestnet } from "viem/chains";

export default createConfig({
  database: {
    kind: "postgres",
    connectionString: process.env.DATABASE_URL,
  },
  chains: {
    riseTestnet: {
      id: riseTestnet.id,
      rpc: riseTestnet.rpcUrls.default.http[0],
      ws: riseTestnet.rpcUrls.default.webSocket[0],
    },
  },
  contracts: {
    Usdc: {
      chain: "riseTestnet",
      abi: erc20Abi,
      address: "0x8A93d247134d91e0de6f96547cB0204e5BE8e5D8",
      startBlock: 16938765,
      endBlock: 16938765 + 30,
    },
  },
});
