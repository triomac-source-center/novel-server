import mongoose from "mongoose";

const { Schema } = mongoose;

// Generic atomic auto-increment counter (the standard MongoDB pattern for this — a single
// findOneAndUpdate with $inc is atomic at the document level, so two simultaneous requests can
// never be handed the same sequence number, unlike "read the current max, then +1 in app code").
const CounterSchema = new Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

const Counter = mongoose.model("counters", CounterSchema);

export default Counter;
