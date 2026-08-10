import Counter from "../models/counter_model.js";

const DEPOSIT_ADDRESS_COUNTER_ID = "depositAddressIndex";

// Atomically hands out the next derivation index, starting at 1. $inc is a single atomic MongoDB
// operation, so two users requesting an address at the same instant can never collide on the
// same index — no read-then-write race window.
//
// Index 0 is permanently reserved for the consolidated hot wallet (see scripts/sweep-deposits.js)
// and must NEVER be handed out to a regular user — returning `counter.seq` (not `counter.seq - 1`)
// means the minimum possible value is 1, on a fresh counter or this already-incremented one alike.
export async function getNextDerivationIndex() {
  const counter = await Counter.findOneAndUpdate(
    { _id: DEPOSIT_ADDRESS_COUNTER_ID },
    { $inc: { seq: 1 } },
    { upsert: true, new: true }
  );
  return counter.seq;
}
