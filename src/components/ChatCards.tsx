import type { useAssistant } from "../hooks/useAssistant";
import type { ChatCard } from "../types";

type Props = { card: ChatCard; assistant: ReturnType<typeof useAssistant> };

/** Rich chat cards, by kind. Each kind lives in its own small component. */
export default function ChatCardView({ card }: Props) {
  switch (card.kind) {
    case "receipt":
      return <div className="font-mono text-meta text-grey">{card.text}</div>;
    default:
      return null;
  }
}
