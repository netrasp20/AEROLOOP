import { useState, useRef, useEffect } from "react";

import "./SaveMissionDialog.css";

type Props = {
  onSave: (name: string) => void;
  onCancel: () => void;
};

function SaveMissionDialog({ onSave, onCancel }: Props) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function handleSave() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Mission name is required.");
      return;
    }
    setError("");
    onSave(trimmed);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSave();
    }
    if (e.key === "Escape") {
      onCancel();
    }
  }

  return (
    <div className="save-mission-overlay" onClick={onCancel}>
      <div
        className="save-mission-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="save-mission-title">Save Mission</h3>

        <label className="save-mission-label">Mission Name</label>

        <div className="save-mission-input-row">
          <input
            ref={inputRef}
            className="save-mission-input"
            type="text"
            placeholder="Enter mission name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (error) setError("");
            }}
            onKeyDown={handleKeyDown}
          />
        </div>

        {error && <div className="save-mission-error">{error}</div>}

        <div className="save-mission-actions">
          <button
            className="save-mission-btn save-mission-btn--cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="save-mission-btn save-mission-btn--save"
            onClick={handleSave}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

export default SaveMissionDialog;
