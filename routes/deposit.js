import express from "express";
import mongoose from "mongoose";

const depositRouter = express.Router();
const Users = mongoose.connection.collection("users");

depositRouter.post("/deposit", async (req, res) => {
  try {
    const { clerkId, amount, description } = req.body;

    // 🔐 validations
    if (!clerkId || typeof amount !== "number" || amount <= 0) {
      return res.status(400).json({ message: "Invalid deposit data" });
    }

    // 1️⃣ Récupérer l'utilisateur
    const user = await Users.findOne({ clerkId });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const balanceBefore = user.wallet?.balance ?? 0;
    const balanceAfter = balanceBefore + amount;

    // 2️⃣ Créer la transaction selon TON schema
    const transaction = {
      type: "credit",
      amount,
      balanceBefore,
      balanceAfter,
      description: description || "Wallet deposit",
      createdAt: new Date(),
    };

    // 3️⃣ Mise à jour atomique
    const updatedUser = await Users.findOneAndUpdate(
      { clerkId },
      {
        $set: { "wallet.balance": balanceAfter },
        $push: { "wallet.transactions": transaction },
      },
      { returnDocument: "after" }
    );

    res.status(200).json({
      message: "Deposit successful",
      wallet: {
        balance: balanceAfter
      },
      transaction,
    });
  } catch (error) {
    console.error("Deposit error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

export default depositRouter;
