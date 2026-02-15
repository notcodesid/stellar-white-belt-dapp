import { useState } from 'react';
import { isConnected, requestAccess, signTransaction } from '@stellar/freighter-api';
import {
  Account,
  Asset,
  BASE_FEE,
  Memo,
  Networks,
  Operation,
  Horizon,
  StrKey,
  TransactionBuilder,
} from 'stellar-sdk';

const server = new Horizon.Server('https://horizon-testnet.stellar.org');
const networkPassphrase = Networks.TESTNET;

function stellarExpertTxUrl(hash) {
  return `https://stellar.expert/explorer/testnet/tx/${hash}`;
}

function extractHorizonResultCodes(error) {
  return error?.response?.data?.extras?.result_codes ?? null;
}

function extractHorizonErrorHash(error) {
  return error?.response?.data?.hash ?? null;
}

function horizonHintFromCodes(resultCodes) {
  if (!resultCodes) return '';
  const ops = Array.isArray(resultCodes.operations) ? resultCodes.operations : [];

  if (ops.includes('op_no_destination')) {
    return 'Destination account is not funded on testnet. Fund it (Friendbot) or use a funded address.';
  }
  if (ops.includes('op_underfunded') || ops.includes('op_low_reserve')) {
    return 'Insufficient spendable XLM. Try a smaller amount and leave XLM for minimum reserve + fees.';
  }
  if (resultCodes.transaction === 'tx_bad_seq') {
    return 'Bad sequence number. Refresh balance and try again.';
  }
  if (resultCodes.transaction === 'tx_insufficient_fee') {
    return 'Fee too low. Try again.';
  }

  return '';
}

function formatHorizonError(error) {
  const data = error?.response?.data;
  const resultCodes = extractHorizonResultCodes(error);

  const parts = [];
  if (data?.title) parts.push(data.title);
  if (data?.detail) parts.push(data.detail);
  if (resultCodes?.transaction) parts.push(`tx: ${resultCodes.transaction}`);
  if (Array.isArray(resultCodes?.operations) && resultCodes.operations.length > 0) {
    parts.push(`op: ${resultCodes.operations.join(', ')}`);
  }

  const hint = horizonHintFromCodes(resultCodes);
  if (hint) parts.push(`hint: ${hint}`);

  if (parts.length > 0) return parts.join(' | ');
  return error?.message || 'Transaction failed.';
}

export default function App() {
  const [address, setAddress] = useState('');
  const [balance, setBalance] = useState('—');
  const [destination, setDestination] = useState('');
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [feedback, setFeedback] = useState({ text: '', type: '', hash: '', url: '' });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const connected = Boolean(address);

  const refreshBalance = async (walletAddress = address) => {
    if (!walletAddress) return;
    try {
      const account = await server.loadAccount(walletAddress);
      const xlm = account.balances.find((item) => item.asset_type === 'native');
      setBalance(xlm ? `${xlm.balance} XLM` : '0 XLM');
    } catch (error) {
      setBalance('Unable to fetch balance');
      setFeedback({ text: `Balance fetch failed: ${error.message}`, type: 'error' });
    }
  };

  const connectWallet = async () => {
    try {
      const connection = await isConnected();
      if (typeof connection === 'object' && connection?.error) throw new Error(connection.error);

      const access = await requestAccess();
      const nextAddress = typeof access === 'string' ? access : access?.address;
      if (!nextAddress) {
        throw new Error(access?.error || 'Freighter did not return an address.');
      }

      setAddress(nextAddress);
      setFeedback({ text: '', type: '', hash: '', url: '' });
      await refreshBalance(nextAddress);
    } catch (error) {
      setFeedback({ text: `Wallet connection failed: ${error.message}`, type: 'error', hash: '', url: '' });
    }
  };

  const disconnectWallet = () => {
    setAddress('');
    setBalance('—');
    setFeedback({ text: '', type: '', hash: '', url: '' });
  };

  const sendTransaction = async (event) => {
    event.preventDefault();
    if (!connected) {
      setFeedback({ text: 'Connect your wallet first.', type: 'error', hash: '', url: '' });
      return;
    }
    if (!StrKey.isValidEd25519PublicKey(destination.trim())) {
      setFeedback({ text: 'Destination address is invalid.', type: 'error', hash: '', url: '' });
      return;
    }
    if (Number(amount) <= 0) {
      setFeedback({ text: 'Amount must be greater than zero.', type: 'error', hash: '', url: '' });
      return;
    }

    setIsSubmitting(true);
    try {
      setFeedback({ text: 'Preparing transaction...', type: '', hash: '', url: '' });

      // Stellar payments require the destination account to exist (be funded).
      try {
        await server.loadAccount(destination.trim());
      } catch (error) {
        if (error?.response?.status === 404) {
          setFeedback({
            text: 'Transaction blocked: destination account is not funded on testnet. Fund it via Friendbot and try again.',
            type: 'error',
            hash: '',
            url: '',
          });
          return;
        }
        throw error;
      }

      const sourceAccount = await server.loadAccount(address);
      const account = new Account(sourceAccount.accountId(), sourceAccount.sequence);

      setFeedback({ text: 'Signing transaction in Freighter...', type: '', hash: '', url: '' });
      const txBuilder = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase,
      })
        .addOperation(
          Operation.payment({
            destination: destination.trim(),
            asset: Asset.native(),
            amount: amount.trim(),
          }),
        )
        .setTimeout(180);

      if (memo.trim()) {
        txBuilder.addMemo(Memo.text(memo.trim()));
      }

      const unsignedTx = txBuilder.build();
      const signed = await signTransaction(unsignedTx.toXDR(), {
        networkPassphrase,
        address,
        accountToSign: address,
      });

      const signedTxXdr = typeof signed === 'string' ? signed : signed?.signedTxXdr;
      if (!signedTxXdr) {
        throw new Error(signed?.error || 'Signing was cancelled.');
      }

      const signedTx = TransactionBuilder.fromXDR(signedTxXdr, networkPassphrase);
      setFeedback({ text: 'Submitting transaction to Stellar testnet...', type: '', hash: '', url: '' });
      const submitResult = await server.submitTransaction(signedTx);

      setFeedback({
        text: 'Success! Transaction submitted. Hash:',
        type: 'success',
        hash: submitResult.hash,
        url: stellarExpertTxUrl(submitResult.hash),
      });
      setDestination('');
      setAmount('');
      setMemo('');
      await refreshBalance();
    } catch (error) {
      const txHash = extractHorizonErrorHash(error);
      setFeedback({
        text: `Transaction failed: ${formatHorizonError(error)}`,
        type: 'error',
        hash: txHash || '',
        url: txHash ? stellarExpertTxUrl(txHash) : '',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="container">
      {isSubmitting ? (
        <div className="loading-overlay" role="status" aria-live="polite" aria-busy="true">
          <div className="spinner" aria-label="Loading" />
        </div>
      ) : null}
      <h1>Stellar White Belt dApp</h1>
      <p className="subtitle">Connect Freighter, check your testnet XLM balance, and send a payment.</p>

      <section className="card">
        <h2>1) Wallet</h2>
        <div className="actions">
          <button onClick={connectWallet} disabled={connected}>Connect Freighter</button>
          <button className="secondary" onClick={disconnectWallet} disabled={!connected}>Disconnect</button>
        </div>
        <p><strong>Address:</strong> {connected ? address : '—'}</p>
      </section>

      <section className="card">
        <h2>2) Balance (Testnet XLM)</h2>
        <div className="actions">
        </div>
        <p><strong>XLM Balance:</strong> {balance}</p>
      </section>

      <section className="card">
        <h2>3) Send XLM</h2>
        <form onSubmit={sendTransaction}>
          <label>
            Destination Address
            <input value={destination} onChange={(e) => setDestination(e.target.value)} required placeholder="G..." />
          </label>
          <label>
            Amount (XLM)
            <input value={amount} onChange={(e) => setAmount(e.target.value)} required type="number" min="0.0000001" step="0.0000001" placeholder="1" />
          </label>
          <button type="submit" disabled={!connected}>Send Transaction</button>
        </form>
        {feedback.text || feedback.hash ? (
          <p className={`feedback ${feedback.type}`.trim()}>
            {feedback.text}{' '}
            {feedback.hash ? (
              <a href={feedback.url} target="_blank" rel="noreferrer">
                {feedback.hash}
              </a>
            ) : null}
          </p>
        ) : null}
      </section>
    </main>
  );
}
