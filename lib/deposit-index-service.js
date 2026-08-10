import Counter from "../models/counter_model.js";

const DEPOSIT_ADDRESS_COUNTER_ID = "depositAddressIndex";

// Atomically hands out the next 0-based derivation index. $inc is a single atomic MongoDB
// operation, so two users requesting an address at the same instant can never collide on the
// same index — no read-then-write race window.
export async function getNextDerivationIndex() {
  const counter = await Counter.findOneAndUpdate(
    { _id: DEPOSIT_ADDRESS_COUNTER_ID },
    { $inc: { seq: 1 } },
    { upsert: true, new: true }
  );
  return counter.seq - 1;
}
