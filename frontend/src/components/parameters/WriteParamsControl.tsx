import { useState } from "react";
import { Loader, Send } from "lucide-react";

import { useParameters } from "../../context/ParameterContext";

import WriteParamsDialog from "./WriteParamsDialog";

export default function WriteParamsControl() {
  const store = useParameters();
  const [dialogOpen, setDialogOpen] = useState(false);

  const running = store.writePhase === "running";
  const hasStaged = store.stagedCount > 0;
  const hasResult =
    store.writePhase === "success" ||
    store.writePhase === "partial_failure" ||
    store.writePhase === "interrupted" ||
    store.writePhase === "error";

  if (!hasStaged && !running && !hasResult) return null;

  return (
    <>
      <button
        type="button"
        className={`btn-write-params ${store.stagedCount > 0 ? "btn-write-params--active" : ""}`}
        onClick={() => setDialogOpen(true)}
        disabled={running}
        title={
          running
            ? "Write in progress..."
            : `Write ${store.stagedCount} modified parameter${store.stagedCount === 1 ? "" : "s"} to the vehicle`
        }
        data-testid="write-params-control"
      >
        {running ? (
          <Loader size={13} className="write-spinner" />
        ) : (
          <Send size={13} />
        )}
        {running ? "Writing..." : `Write (${store.stagedCount})`}
      </button>
      <WriteParamsDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </>
  );
}
