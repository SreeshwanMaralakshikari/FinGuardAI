/**
 * @file src/components/common/PayeeNotice.jsx
 * @description TEJAS D1: what the paying customer is told about the payee after submitting. Only their own view:
 *   a warning when the payee is on the watchlist (it received money in confirmed fraud), and a note on a first
 *   payment to a UPI ID. Other customers' activity is never shown to customers.
 */
import Alert from './Alert.jsx';

/** @param {{ result: { payee?: { vpa?: string }|null, payeeSignals?: { firstTimePayee: boolean, watchlisted: boolean }|null } }} props */
export default function PayeeNotice({ result }) {
  const s = result?.payeeSignals;
  if (!s) return null;
  if (s.watchlisted) {
    return (
      <Alert tone="warning">
        This payee has received money in confirmed fraud cases. If someone asked you to make this payment, stop and
        contact your bank before paying them again.
      </Alert>
    );
  }
  if (s.firstTimePayee && result.payee?.vpa) {
    return <Alert tone="info">This is your first payment to {result.payee.vpa}. Check the UPI ID before paying them again.</Alert>;
  }
  return null;
}
