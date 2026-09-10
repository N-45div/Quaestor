import express from "express";
import { mountExplorer } from "../services/explorer";

// Read-only preview: never starts Cato, the guardian, or the sponsored faucet.
const app = express();
app.use((_req, res, next) => { res.setHeader("Access-Control-Allow-Origin", "*"); next(); });
mountExplorer(app);
app.listen(8403, "127.0.0.1", () => console.log("Read-only explorer API on http://127.0.0.1:8403"));
