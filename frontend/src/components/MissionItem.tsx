import { useState, useRef, useEffect, useCallback } from "react";

import type { MissionInfo } from "../types/mission";

type MissionItemProps = {
  mission: MissionInfo;
  onLoad: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDeleteRequest: (id: string) => void;
};

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function MissionItem({
  mission,
  onLoad,
  onRename,
  onDeleteRequest,
}: MissionItemProps) {
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(mission.id);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const closeMenu = useCallback(() => setContextMenu(null), []);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        closeMenu();
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeMenu();
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [closeMenu]);

  useEffect(() => {
    if (renaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [renaming]);

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }

  function handleRenameSubmit() {
    const trimmed = newName.trim();
    if (trimmed && trimmed !== mission.id) {
      onRename(mission.id, trimmed);
    }
    setRenaming(false);
    closeMenu();
  }

  function handleLoad() {
    onLoad(mission.id);
    closeMenu();
  }

  function handleDeleteClick() {
    onDeleteRequest(mission.id);
    closeMenu();
  }

  function handleRenameClick() {
    setNewName(mission.id);
    setRenaming(true);
    closeMenu();
  }

  return (
    <>
      <div
        className="mission-item"
        onContextMenu={handleContextMenu}
        onClick={handleLoad}
      >
        <div className="mission-item-main">
          <span className="mission-item-icon">📄</span>

          <div className="mission-item-info">
            {renaming ? (
              <input
                ref={inputRef}
                className="mission-rename-input"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleRenameSubmit();
                  if (e.key === "Escape") setRenaming(false);
                }}
                onBlur={handleRenameSubmit}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="mission-item-name">{mission.id}</span>
            )}

            <span className="mission-item-meta">
              {mission.waypointCount} waypoint
              {mission.waypointCount !== 1 ? "s" : ""}
              {mission.hasHome ? " • Home set" : ""}
              {" • "}
              {formatDate(mission.timestamp)}
            </span>
          </div>
        </div>
      </div>

      {contextMenu && (
        <div
          ref={menuRef}
          className="mission-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button className="ctx-item" onClick={handleLoad}>
            <span className="ctx-icon">▶</span>
            Upload Mission
          </button>
          <button className="ctx-item" onClick={handleRenameClick}>
            <span className="ctx-icon">✏</span>
            Rename Mission
          </button>
          <div className="ctx-divider" />
          <button className="ctx-item danger" onClick={handleDeleteClick}>
            <span className="ctx-icon">🗑</span>
            Delete Mission
          </button>
        </div>
      )}
    </>
  );
}

export default MissionItem;
