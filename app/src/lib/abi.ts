export const QUAESTOR_ABI = [
  {
    type: "function",
    name: "registerAgent",
    stateMutability: "payable",
    inputs: [
      { name: "operator", type: "address" },
      { name: "epochLength", type: "uint32" },
      { name: "metadataURI", type: "string" },
      {
        name: "dataPolicy",
        type: "tuple",
        components: [
          { name: "epochCap", type: "uint128" },
          { name: "perCallCap", type: "uint128" },
        ],
      },
      {
        name: "inferencePolicy",
        type: "tuple",
        components: [
          { name: "epochCap", type: "uint128" },
          { name: "perCallCap", type: "uint128" },
        ],
      },
      {
        name: "executionPolicy",
        type: "tuple",
        components: [
          { name: "epochCap", type: "uint128" },
          { name: "perCallCap", type: "uint128" },
        ],
      },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "deposit",
    stateMutability: "payable",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "suspend",
    stateMutability: "nonpayable",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "resume",
    stateMutability: "nonpayable",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "nextAgentId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "agents",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [
      { name: "owner", type: "address" },
      { name: "operator", type: "address" },
      { name: "suspended", type: "bool" },
      { name: "registeredAt", type: "uint40" },
      { name: "epochLength", type: "uint32" },
      { name: "metadataURI", type: "string" },
    ],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "policyOf",
    stateMutability: "view",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "category", type: "uint8" },
    ],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "epochCap", type: "uint128" },
          { name: "perCallCap", type: "uint128" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "currentEpoch",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "spentIn",
    stateMutability: "view",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "category", type: "uint8" },
      { name: "epoch", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "event",
    name: "AgentRegistered",
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "owner", type: "address", indexed: true },
      { name: "operator", type: "address", indexed: false },
      { name: "epochLength", type: "uint32", indexed: false },
      { name: "metadataURI", type: "string", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Receipt",
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "category", type: "uint8", indexed: true },
      { name: "payee", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
      { name: "metaHash", type: "bytes32", indexed: false },
      { name: "epoch", type: "uint256", indexed: false },
      { name: "epochSpentAfter", type: "uint256", indexed: false },
    ],
  },
  {
    type: "function",
    name: "setGuardian",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "guardian", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "guardianOf",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "setPolicy",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "category", type: "uint8" },
      {
        name: "policy",
        type: "tuple",
        components: [
          { name: "epochCap", type: "uint128" },
          { name: "perCallCap", type: "uint128" },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "amount", type: "uint256" },
      { name: "to", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "Suspended",
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "by", type: "address", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Resumed",
    inputs: [{ name: "agentId", type: "uint256", indexed: true }],
  },
  {
    type: "event",
    name: "Deposited",
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "from", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
] as const;

export const TOKEN_ABI = [
  {
    type: "function",
    name: "faucet",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
] as const;

export const DEX_ABI = [
  {
    type: "function",
    name: "spotPrice",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "pools",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [
      { name: "reserveNative", type: "uint256" },
      { name: "reserveToken", type: "uint256" },
      { name: "totalShares", type: "uint256" },
    ],
  },
] as const;
