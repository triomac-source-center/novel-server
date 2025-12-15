import express from "express";
import { Register } from "../middleware/middlewares.js";

const SignupRouter = express.Router()

SignupRouter.get('/signup', Register)

export default SignupRouter