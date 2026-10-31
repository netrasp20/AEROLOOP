import { useCallback } from "react";
import { RotateCcw } from "lucide-react";

import { useParameters } from "../../context/ParameterContext";
import type { PayloadParamField } from "../../api/setup";
import ParamValueEditor from "../parameters/ParamValueEditor";

interface Props {
  field: PayloadParamField;
  /** Render the live value without an editor. */
  readOnly?: boolean;
}

function displayValue(field: PayloadParamField, value: number | null): string {
  if (value === null) return "Unavailable";
  if (field.kind === "bitmask" && field.bits && field.decoded) return field.decoded;
  if (field.kind === "enum" && field.decoded) return `${field.decoded} (${value})`;
  return `${value}${field.units ? ` ${field.units}` : ""}`;
}

/**
 * One configuration parameter on the Logging / Scripting pages.
 *
 * Editing is delegated to the shared ParameterContext editor, so a change is
 * staged locally exactly like everywhere else in the app and only reaches the
 * vehicle through the existing verified write transaction. This component adds
 * no write path of its own.
 */
export default function SetupParamField({ field, readOnly }: Props) {
  const store = useParameters();
  const entry = store.entries[field.id];
  const staged = store.staged[field.id] ?? null;
  const current = staged?.stagedValue ?? entry?.live?.value ?? field.value;
  const editable = !readOnly && field.writable && Boolean(entry);

  const onStage = useCallback(
    (value: number) => store.stageValue(field.id, value),
    [field.id, store],
  );

  return (
    <div
      className={`setup-payload-field${staged ? " staged" : ""}`}
      data-testid={`payload-field-${field.id}`}
    >
      <span className="setup-payload-label">
        {field.name}
        <em className="actuator-param-id">{field.id}</em>
        {field.rebootRequired && <em className="setup-payload-reboot">Reboot required</em>}
      </span>
      {editable ? (
        <div className="setup-payload-value">
          <ParamValueEditor entry={entry} staged={staged} onStage={onStage} />
          {staged && (
            <button
              type="button"
              className="setup-payload-revert"
              onClick={() => store.revert(field.id)}
              data-testid={`payload-revert-${field.id}`}
            >
              <RotateCcw size={12} /> Revert
            </button>
          )}
        </div>
      ) : (
        <span
          className="setup-payload-value"
          data-testid={`payload-value-${field.id}`}
        >
          {displayValue(field, current)}
        </span>
      )}
    </div>
  );
}
