// Structured LastKey events consumed by LastKey-Notify. Signatures must match LastKey.sol exactly.
const { Interface } = require("ethers");

const EVENT_ABI = [
  "event CheckInReceived(bytes32 indexed vaultId, address indexed owner, address indexed by, uint64 epoch, uint256 deadline, uint256 timestamp)",
  "event VaultFunded(bytes32 indexed vaultId, address indexed owner, address indexed funder, uint256 amount, uint256 deposited)",
  "event TimerWarning(bytes32 indexed vaultId, address indexed owner, uint64 epoch, uint256 deadline, uint256 claimOpensAt, uint16 elapsedBps, uint256 timestamp)",
  "event ClaimOpened(bytes32 indexed vaultId, address indexed owner, uint64 epoch, uint256 claimOpensAt, uint256 timestamp)",
];

const iface = new Interface(EVENT_ABI);
const NAME_BY_TOPIC = {};
for (const f of iface.fragments) {
  if (f.type === "event") NAME_BY_TOPIC[f.topicHash] = f.name;
}
const TOPICS = Object.keys(NAME_BY_TOPIC);

function jsonSafe(v) {
  if (typeof v === "bigint") return v.toString();
  return v;
}

/// Decode a raw log. Returns null for logs that are not LastKey-Notify events.
function decodeLog(log) {
  const name = NAME_BY_TOPIC[log.topics[0]];
  if (!name) return null;
  const parsed = iface.parseLog({ topics: log.topics, data: log.data });
  const args = {};
  parsed.fragment.inputs.forEach((input, i) => {
    args[input.name] = jsonSafe(parsed.args[i]);
  });
  return {
    type: name,
    vaultId: String(args.vaultId).toLowerCase(),
    owner: String(args.owner).toLowerCase(),
    args,
  };
}

module.exports = { EVENT_ABI, TOPICS, decodeLog };
