export interface MapViewState {
  center: [number, number];
  zoom: number;
}

let saved: MapViewState | null = null;

export function getSavedMapView(): MapViewState | null {
  return saved;
}

export function saveMapView(view: MapViewState): void {
  saved = view;
}
