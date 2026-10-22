import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { opHref, type ChatRole } from "../../lib/operator";
import { ChatPanel } from "./ChatPanel";

/** Talk to the Operator, in the explorer: the same conversation as the outreach page's, as a full page. */
export function OpChat() {
  const [role, setRole] = useState<ChatRole>(() => {
    try { return localStorage.getItem("quaestor-operator-chat-role") === "creator" ? "creator" : "business"; } catch { return "business"; }
  });
  return <>
    <section className="page-intro compact"><div>
      <a className="back-link" href={opHref("")}><ArrowLeft size={13} />Quaestor Operator</a>
      <span className="eyebrow">TALK TO THE OPERATOR · MUSD ON MEZO, USDC ON ARC</span>
      <h1>{role === "business" ? "Say what you want promoted" : "Find paid work that fits you"}</h1>
      <p>{role === "business"
        ? "The Operator drafts the project, finds proven creators who fit each task, and quotes how to fund it from your BTC. Nothing moves until your wallet signs the budget."
        : "Tell the Operator what you make and where you are paid. Prove your handles once, and it shows you the paid tasks that fit. You are paid only for delivered work it has checked."}</p>
    </div></section>
    <ChatPanel variant="page" role={role} onRole={setRole} />
  </>;
}
