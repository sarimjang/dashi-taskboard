import { useState, type KeyboardEvent } from "react";
import type { ActorIdentity } from "../types";
import { classifyMediaUrl } from "../mediaAccessPolicy";
import { useTaskboardI18n } from "../i18n";

export function ActorAvatar({
  actor,
  className = "",
}: {
  actor: ActorIdentity;
  className?: string;
}) {
  const { text } = useTaskboardI18n();
  const [revealed, setRevealed] = useState(false);
  const decision = actor.type !== "agent" && actor.avatarUrl
    ? classifyMediaUrl(actor.avatarUrl)
    : null;
  const isGated = decision === "external" && !revealed;
  const showAvatarImage = Boolean(actor.avatarUrl)
    && (decision === "attachment" || (decision === "external" && revealed));

  function reveal() {
    setRevealed(true);
  }

  return (
    <span
      className={`actor-avatar actor-avatar-${actor.type}${className ? ` ${className}` : ""}${isGated ? " is-avatar-gate" : ""}`}
      title={actor.name}
      {...(isGated
        ? {
          role: "button" as const,
          tabIndex: 0,
          "aria-label": text(`点击加载 ${actor.name} 的头像`, `Click to load ${actor.name}'s avatar`),
          onClick: reveal,
          onKeyDown: (event: KeyboardEvent<HTMLSpanElement>) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            reveal();
          },
        }
        : { "aria-hidden": true as const })}
    >
      {actor.type === "agent" ? (
        <img
          className="actor-avatar-image actor-avatar-agent-image"
          src="codex-agent-logo.png"
          alt=""
        />
      ) : showAvatarImage ? (
        <img
          className="actor-avatar-image"
          src={actor.avatarUrl!}
          alt=""
          referrerPolicy="no-referrer"
        />
      ) : actor.name.slice(0, 1)}
    </span>
  );
}
