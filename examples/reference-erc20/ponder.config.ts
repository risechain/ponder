import { createConfig } from "ponder-rise";
import { erc20ABI } from "./abis/erc20ABI";

export default createConfig({
  chains: {
    riseTestnet: {
      id: 11155931,
      rpc: "https://testnet.riselabs.xyz",
      ws: "wss://testnet.riselabs.xyz/ws",
    },
  },
  contracts: {
    ERC20: {
      chain: "riseTestnet",
      abi: erc20ABI,
      address: "0x8A93d247134d91e0de6f96547cB0204e5BE8e5D8",
      startBlock: "latest",
    },
  },
});
