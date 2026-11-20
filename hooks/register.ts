// The Claude Code mod of the plugin: it draws each reply without its waive lines, a resumed session's included, which
// the MessageDisplay hook never sees again. The rest of the chain, a mod that draws views among it, gets the text
// already clean. Display only: the stored message, the one the stop reads, keeps them.
import type { Register } from "claude-code";
import { hideWaives } from "../src/core/waive-line.ts";

export const register: Register = (on) => {
  on("ui.render", { component: "AssistantMessage" }, ($, e, next) => {
    const text = hideWaives(e.props.text);
    return text === e.props.text ? next(e) : next({ ...e, props: { ...e.props, text } });
  });
};
