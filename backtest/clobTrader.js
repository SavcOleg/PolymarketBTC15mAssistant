import { ClobClient, Side, OrderType, AssetType } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import { ethers } from "ethers";

// ─── Polygon on-chain redemption constants ───────────────────────────────────
// Multiple Polygon RPCs — tried in order until one works
const POLYGON_RPCS = [
  "https://polygon-bor-rpc.publicnode.com",
  "https://rpc.ankr.com/polygon",
  "https://polygon.llamarpc.com",
  "https://polygon.drpc.org",
];
const CTF_ADDRESS   = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const USDC_ADDRESS  = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // USDC.e

const CTF_ABI = [
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets)",
];
const SAFE_ABI = [
  "function nonce() view returns (uint256)",
  "function getTransactionHash(address to,uint256 value,bytes calldata data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 _nonce) view returns (bytes32)",
  "function execTransaction(address to,uint256 value,bytes calldata data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address payable refundReceiver,bytes memory signatures) payable returns (bool success)",
];

let client = null;
let initError = null;

export function getClobStatus() {
  if (initError) return { connected: false, error: initError };
  if (!client) return { connected: false, error: "Not initialized" };
  return { connected: true, funder: process.env.POLYMARKET_FUNDER_ADDRESS };
}

export async function initClobClient() {
  const apiKey = process.env.POLYMARKET_API_KEY;
  const funder = process.env.POLYMARKET_FUNDER_ADDRESS;
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  const apiSecret = process.env.POLYMARKET_API_SECRET;
  const apiPassphrase = process.env.POLYMARKET_API_PASSPHRASE;

  if (!privateKey) {
    initError = "POLYMARKET_PRIVATE_KEY not set — needed for order signing";
    console.warn("[CLOB] " + initError);
    return null;
  }

  try {
    const host = "https://clob.polymarket.com";
    const signer = new Wallet(privateKey);

    let creds;
    if (apiKey && apiSecret && apiPassphrase) {
      creds = { key: apiKey, secret: apiSecret, passphrase: apiPassphrase };
    } else {
      // Derive L2 credentials from wallet — do NOT pass funder param to createOrDeriveApiKey
      const tempClient = new ClobClient(host, 137, signer, null, 0, funder);
      creds = await tempClient.createOrDeriveApiKey();
    }

    const sigType = Number(process.env.POLYMARKET_SIGNATURE_TYPE ?? "1");
    client = new ClobClient(host, 137, signer, creds, sigType, funder, undefined, true);
    console.log(`[CLOB] Client ready (sigType=${sigType}, useServerTime=true) for`, funder);

    initError = null;
    return client;
  } catch (err) {
    initError = err.message;
    console.error("[CLOB] Init failed:", err.message);
    return null;
  }
}

function isClobError(resp) {
  return !resp || resp.error || resp.status >= 400 || resp.errorMsg;
}

export async function placeBuyOrder({ tokenId, price, size, tickSize, negRisk = false }) {
  if (!client) {
    return { ok: false, error: initError || "CLOB client not initialized" };
  }

  try {
    const resp = await client.createAndPostOrder(
      { tokenID: tokenId, price: Number(price), side: Side.BUY, size: Number(size) },
      { tickSize, negRisk },  // tickSize=undefined → auto-resolved by CLOB client
      OrderType.GTC,
    );
    if (isClobError(resp)) {
      const msg = resp?.error || resp?.errorMsg || `status ${resp?.status}`;
      console.error("[CLOB] Order rejected:", msg, JSON.stringify(resp));
      return { ok: false, error: msg, order: resp };
    }
    console.log("[CLOB] Order placed:", JSON.stringify(resp));
    return { ok: true, order: resp };
  } catch (err) {
    console.error("[CLOB] Order failed:", err.message);
    return { ok: false, error: err.message };
  }
}

export async function placeSellOrder({ tokenId, price, size, tickSize, negRisk = false }) {
  if (!client) {
    return { ok: false, error: initError || "CLOB client not initialized" };
  }
  try {
    const resp = await client.createAndPostOrder(
      { tokenID: tokenId, price: Number(price), side: Side.SELL, size: Number(size) },
      { tickSize, negRisk },  // tickSize=undefined → auto-resolved
      OrderType.GTC,
    );
    if (isClobError(resp)) {
      const msg = resp?.error || resp?.errorMsg || `status ${resp?.status}`;
      console.error("[CLOB] Sell rejected:", msg, JSON.stringify(resp));
      return { ok: false, error: msg, order: resp };
    }
    console.log("[CLOB] Sell order placed:", JSON.stringify(resp));
    return { ok: true, order: resp };
  } catch (err) {
    console.error("[CLOB] Sell order failed:", err.message);
    return { ok: false, error: err.message };
  }
}

export async function cancelOrder(orderId) {
  if (!client) {
    return { ok: false, error: initError || "CLOB client not initialized" };
  }
  try {
    const resp = await client.cancelOrder({ orderID: orderId });
    console.log("[CLOB] Order cancelled:", orderId, JSON.stringify(resp));
    return { ok: true, result: resp };
  } catch (err) {
    console.error("[CLOB] Cancel order failed:", err.message);
    return { ok: false, error: err.message };
  }
}

export async function cancelAllOrders() {
  if (!client) {
    return { ok: false, error: initError || "CLOB client not initialized" };
  }
  try {
    const resp = await client.cancelAll();
    console.log("[CLOB] All orders cancelled:", JSON.stringify(resp));
    return { ok: true, result: resp };
  } catch (err) {
    console.error("[CLOB] Cancel all orders failed:", err.message);
    return { ok: false, error: err.message };
  }
}

export async function getBalances() {
  if (!client) return { ok: false, error: "Not initialized" };
  try {
    const bal = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    return { ok: true, balances: bal };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function parseTs(t) {
  if (t == null || t === "") return 0;
  const n = Number(t);
  if (Number.isFinite(n) && n > 1e12) return n;          // already milliseconds
  if (Number.isFinite(n) && n > 1e9)  return n * 1000;   // Unix seconds → ms
  const d = new Date(t).getTime();
  return Number.isFinite(d) ? d : 0;
}

/** CLOB returns collateral balance as micro-USDC (6 decimals), e.g. "9039472" → 9.039472 */
function microUsdcToDecimal(raw) {
  const s = String(raw ?? "0").trim();
  if (s.includes(".")) return s;
  const n = BigInt(s.replace(/\D/g, "") || "0");
  const whole = Number(n / 1_000_000n);
  const frac = Number(n % 1_000_000n) / 1e6;
  return String(whole + frac);
}

/** CLOB returns allowances as {contractAddr: uint256_string} — if any entry is non-zero, approved */
function parseAllowance(collateral) {
  const allowances = collateral?.allowances ?? {};
  const vals = Object.values(allowances);
  if (vals.length === 0) return "0";
  // max uint256 means unlimited approval — show as "approved"
  const maxUint = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
  for (const v of vals) {
    try {
      const bn = BigInt(v);
      if (bn >= maxUint / 2n) return "approved";
      if (bn > 0n) return microUsdcToDecimal(v);
    } catch {}
  }
  return "0";
}

export async function fetchPolymarketAccountSnapshot() {
  if (!client) {
    return { ok: false, error: initError || "CLOB client not initialized" };
  }
  try {
    const [collateral, tradesRaw, openRaw] = await Promise.all([
      client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL }),
      client.getTrades(undefined, true),
      client.getOpenOrders(undefined, true),
    ]);

    const trades = (Array.isArray(tradesRaw) ? tradesRaw : [])
      .map((t) => {
        const rawTime = t.match_time || t.last_update;
        const tsMs = parseTs(rawTime);
        const isoTime = tsMs > 0 ? new Date(tsMs).toISOString() : rawTime;
        return {
        id: t.id,
        time: isoTime,
        ts: tsMs,
        side: t.side,
        outcome: t.outcome,
        price: t.price,
        size: t.size,
        status: t.status,
        market: t.market,
        role: t.trader_side,
        feeRateBps: t.fee_rate_bps,
      };})
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 40);

    const openOrders = (Array.isArray(openRaw) ? openRaw : [])
      .map((o) => ({
        id: o.id,
        side: o.side,
        outcome: o.outcome,
        price: o.price,
        originalSize: o.original_size,
        sizeMatched: o.size_matched,
        status: o.status,
        createdAt: o.created_at,
      }))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, 25);

    return {
      ok: true,
      updatedAt: Date.now(),
      funder: process.env.POLYMARKET_FUNDER_ADDRESS || null,
      collateral: {
        balance: microUsdcToDecimal(collateral?.balance),
        allowance: parseAllowance(collateral),
        balanceRaw: collateral?.balance ?? "0",
        allowanceRaw: JSON.stringify(collateral?.allowances ?? {}),
      },
      openOrderCount: openOrders.length,
      openOrders,
      trades,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── Auto-claim winning positions ────────────────────────────────────────────

/**
 * Fetch all redeemable positions for the configured wallet from Polymarket's data API.
 * Returns an array of positions with conditionId, outcomeIndex, size fields.
 */
export async function fetchRedeemablePositions() {
  const funder = process.env.POLYMARKET_FUNDER_ADDRESS;
  if (!funder) return [];
  try {
    const url = `https://data-api.polymarket.com/positions?user=${funder}&redeemable=true&sizeThreshold=0.001`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    // Only redeem positions that have actual value (curPrice ≥ 0.95 = market resolved in our favor)
    return Array.isArray(data) ? data.filter(p =>
      p.redeemable &&
      parseFloat(p.size || 0) > 0.001 &&
      parseFloat(p.curPrice || 0) >= 0.95
    ) : [];
  } catch {
    return [];
  }
}

/**
 * Redeem all winning positions on-chain.
 *
 * For EOA (sigType=0): direct CTF.redeemPositions() call.
 * For Safe/Proxy (sigType=1): builds a Safe EIP-712 tx, signs with the EOA key, calls execTransaction.
 */
export async function redeemWinningPositions() {
  const funder  = process.env.POLYMARKET_FUNDER_ADDRESS;
  const pk      = process.env.POLYMARKET_PRIVATE_KEY;
  const sigType = Number(process.env.POLYMARKET_SIGNATURE_TYPE ?? "1");

  if (!funder || !pk) return { ok: false, error: "Wallet not configured" };

  const positions = await fetchRedeemablePositions();
  if (!positions.length) return { ok: true, redeemed: 0, message: "No redeemable positions" };

  console.log(`[REDEEM] Found ${positions.length} redeemable position(s)`);

  // Try each RPC until one responds
  let provider;
  for (const rpc of POLYGON_RPCS) {
    try {
      const p = new ethers.JsonRpcProvider(rpc);
      await p.getBlockNumber(); // test connection
      provider = p;
      console.log(`[REDEEM] Using RPC: ${rpc}`);
      break;
    } catch { /* try next */ }
  }
  if (!provider) return { ok: false, error: "All Polygon RPCs unreachable" };

  const signer = new ethers.Wallet(pk, provider);
  const signerAddress = signer.address;

  // Pre-flight MATIC balance check
  const maticBal = await provider.getBalance(signerAddress);
  const maticFloat = parseFloat(ethers.formatEther(maticBal));
  console.log(`[REDEEM] Signer ${signerAddress} MATIC balance: ${maticFloat}`);
  if (maticFloat < 0.01) {
    return {
      ok: false,
      error: `Signer wallet needs MATIC for gas. Send at least 0.1 MATIC to ${signerAddress} on Polygon network (current: ${maticFloat.toFixed(4)} MATIC). MATIC ≈ $0.05 each.`,
      signerAddress,
      maticBalance: maticFloat,
      needsMatic: true,
    };
  }
  const ctfIface = new ethers.Interface(CTF_ABI);

  const results = [];

  for (const pos of positions) {
    const conditionId  = pos.conditionId;
    const outcomeIndex = pos.outcomeIndex ?? (pos.outcome === "Yes" || pos.outcome === "Up" ? 0 : 1);
    const indexSet     = 1 << outcomeIndex;  // 1 for outcome-0 (UP/Yes), 2 for outcome-1 (DOWN/No)
    const sizeLabel    = pos.size ?? "?";

    console.log(`[REDEEM] Redeeming conditionId=${conditionId} outcome=${outcomeIndex} size=${sizeLabel} indexSet=${indexSet}`);

    try {
      const calldata = ctfIface.encodeFunctionData("redeemPositions", [
        USDC_ADDRESS,
        ethers.ZeroHash,
        conditionId,
        [indexSet],
      ]);

      let txHash;

      if (sigType === 0) {
        // ── EOA: direct call ──────────────────────────────────────────────────
        const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, signer);
        const tx  = await ctf.redeemPositions(
          USDC_ADDRESS, ethers.ZeroHash, conditionId, [indexSet],
          { gasLimit: 250_000 },
        );
        txHash = tx.hash;
        await tx.wait(1);
        console.log(`[REDEEM] EOA tx confirmed: ${txHash}`);
      } else {
        // ── Safe/Proxy: EIP-712 execTransaction ───────────────────────────────
        const safe = new ethers.Contract(funder, SAFE_ABI, signer);

        // Read nonce: try the contract function first, fall back to storage slot 5
        let nonce;
        try {
          nonce = Number(await safe.nonce());
        } catch {
          // Gnosis Safe stores nonce at storage slot 5
          const raw = await provider.getStorage(funder, 5);
          nonce = Number(ethers.toBigInt(raw));
        }
        console.log(`[REDEEM] Safe nonce=${nonce}`);

        // Build EIP-712 Safe tx hash
        let safeTxHash;
        try {
          safeTxHash = await safe.getTransactionHash(
            CTF_ADDRESS, 0, calldata, 0, 0, 0, 0,
            ethers.ZeroAddress, ethers.ZeroAddress, nonce,
          );
        } catch {
          // Manual EIP-712 hash if getTransactionHash isn't available
          const SAFE_TX_TYPEHASH = "0xbb8310d486368db6bd6f849402fdd73ad53d316b5a4b2644ad6efe0f941286d8";
          const DOMAIN_SEPARATOR_TYPEHASH = "0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218";
          const domainSep = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
            ["bytes32", "uint256", "address"],
            [DOMAIN_SEPARATOR_TYPEHASH, 137, funder],
          ));
          const txDataHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
            ["bytes32","address","uint256","bytes32","uint8","uint256","uint256","uint256","address","address","uint256"],
            [SAFE_TX_TYPEHASH, CTF_ADDRESS, 0, ethers.keccak256(calldata), 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, nonce],
          ));
          safeTxHash = ethers.keccak256(ethers.concat(["0x1901", domainSep, txDataHash]));
        }

        // Sign the Safe tx hash with EOA key (v += 4 for Gnosis Safe "approved" signature type)
        const sigBytes = await signer.signMessage(ethers.getBytes(safeTxHash));
        const sig = sigBytes.slice(0, -2) + (parseInt(sigBytes.slice(-2), 16) + 4).toString(16);

        const tx = await safe.execTransaction(
          CTF_ADDRESS, 0, calldata, 0, 0, 0, 0,
          ethers.ZeroAddress, ethers.ZeroAddress, sig,
          { gasLimit: 500_000 },
        );
        txHash = tx.hash;
        await tx.wait(1);
        console.log(`[REDEEM] Safe tx confirmed: ${txHash}`);
      }

      results.push({ ok: true, conditionId, indexSet, txHash });
    } catch (err) {
      console.error(`[REDEEM] Failed conditionId=${conditionId}:`, err.message);
      results.push({ ok: false, conditionId, indexSet, error: err.message });
    }
  }

  const succeeded = results.filter(r => r.ok).length;
  return {
    ok: results.length > 0,
    redeemed: succeeded,
    failed: results.length - succeeded,
    results,
  };
}
