import { createContext, useContext, type ReactNode } from "react";
import { useGeolocation, type GeolocationState } from "../hooks/useGeolocation";

const OperatorLocationContext = createContext<GeolocationState | null>(null);

export function OperatorLocationProvider({ children }: { children: ReactNode }) {
  const geo = useGeolocation();
  return (
    <OperatorLocationContext.Provider value={geo}>
      {children}
    </OperatorLocationContext.Provider>
  );
}

export function useOperatorLocation(): GeolocationState {
  const context = useContext(OperatorLocationContext);
  if (context === null) {
    throw new Error("useOperatorLocation must be used inside OperatorLocationProvider");
  }
  return context;
}
