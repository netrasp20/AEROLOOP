import { useState, useRef, useEffect, useCallback } from "react";

import type { MissionInfo } from "../types/mission";

type UploadCardMenuProps = {
  mission: MissionInfo;
  onLoad: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDuplicate: (id: string) => void;
  onUpload: (id: string) => void;
  onDelete: (id: string) => void;
  disabled: boolean;
};

function UploadCardMenu({
  mission,
  onLoad,
  onRename,
  onDuplicate,
  onUpload,
  onDelete,
  disabled,
}: UploadCardMenuProps) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(mission.id);
  const menuRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setRenaming(false);
  }, []);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (open && menuRef.current && !menuRef.current.contains(e.target as Node) && btnRef.current && !btnRef.current.contains(e.target as Node)) {
        close();
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    if (open) {
      document.addEventListener("mousedown", handleClick);
      document.addEventListener("keydown", handleKey);
    }
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open, close]);

  useEffect(() => {
    if (renaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [renaming]);

  function handleRenameSubmit() {
    const trimmed = newName.trim();
    if (trimmed && trimmed !== mission.id) {
      onRename(mission.id, trimmed);
    }
    setRenaming(false);
    close();
  }

  function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    setOpen((v) => !v);
  }

  return (
    <>
      <button
        ref={btnRef}
        className="upload-card-menu-btn"
        onClick={handleClick}
        disabled={disabled}
        title="Mission actions"
      >
        ⋮
      </button>

      {open && (
        <div ref={menuRef} className="upload-card-menu-dropdown">
          {renaming ? (
            <div className="upload-card-menu-rename">
              <input
                ref={inputRef}
                className="mission-rename-input"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") handleRenameSubmit();
                  if (e.key === "Escape") setRenaming(false);
                }}
                onBlur={handleRenameSubmit}
                onClick={(e) => e.stopPropagation()}
              />
            </div>
          ) : (
            <>
              <button
                className="ctx-item"
                onClick={(e) => { e.stopPropagation(); onLoad(mission.id); close(); }}
              >
                <span className="ctx-icon">📂</span>
                Load Mission
              </button>
              <button
                className="ctx-item"
                onClick={(e) => { e.stopPropagation(); setNewName(mission.id); setRenaming(true); }}
              >
                <span className="ctx-icon">✏️</span>
                Rename Mission
              </button>
              <button
                className="ctx-item"
                onClick={(e) => { e.stopPropagation(); onDuplicate(mission.id); close(); }}
              >
                <span className="ctx-icon">📋</span>
                Duplicate Mission
              </button>
              <button
                className="ctx-item"
                onClick={(e) => { e.stopPropagation(); onUpload(mission.id); close(); }}
              >
                <span className="ctx-icon">📤</span>
                Upload Mission
              </button>
              <div className="ctx-divider" />
              <button
                className="ctx-item danger"
                onClick={(e) => { e.stopPropagation(); onDelete(mission.id); close(); }}
              >
                <span className="ctx-icon">🗑️</span>
                Delete Mission
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}

export default UploadCardMenu;
