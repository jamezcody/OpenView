'use client';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import type { EarthHandle, Pick as EarthPick } from '@/components/earth';
import type { Bounds, CameraView } from '@/lib/model';
import {
  addressLabel,
  validateBounds,
  type AddressPoint,
  type AddressSnapshot,
  type LandParcelSnapshot,
  type LandParcelFeature,
  type PropertyInquiry,
  type InquiryEvent,
} from '@/lib/land-model';

type OverlayState<T> = { data: T | null; loading: boolean; error: string };
const empty = <T>(): OverlayState<T> => ({
  data: null,
  loading: false,
  error: '',
});
export function useLandExplorer(
  globe: RefObject<EarthHandle | null>,
  view: CameraView,
) {
  const [addressesVisible, updateAddressesVisible] = useState(false),
    [parcelsVisible, updateParcelsVisible] = useState(false);
  const [addresses, setAddresses] = useState(empty<AddressSnapshot>),
    [parcels, setParcels] = useState(empty<LandParcelSnapshot>);
  const [selectedAddress, setSelectedAddress] = useState<AddressPoint | null>(
      null,
    ),
    [inquiry, setInquiry] = useState<PropertyInquiry | null>(null),
    [inquiryError, setInquiryError] = useState(''),
    [inquiring, setInquiring] = useState(false);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null),
    [refresh, setRefresh] = useState(0),
    [areaMessage, setAreaMessage] = useState(
      'Zoom into a neighborhood to display addresses and parcel lines.',
    );
  const addressRequest = useRef<AbortController | null>(null),
    parcelRequest = useRef<AbortController | null>(null),
    inquiryRequest = useRef<AbortController | null>(null),
    lastArea = useRef('');
  const close = useCallback(() => {
    inquiryRequest.current?.abort();
    setSelectedAddress(null);
    setInquiry(null);
    setInquiryError('');
    setInquiring(false);
    setAnchor(null);
  }, []);
  const selectAddress = useCallback((a: AddressPoint) => {
    inquiryRequest.current?.abort();
    setSelectedAddress(a);
    setInquiry(null);
    setInquiryError('');
    setInquiring(false);
    setAnchor(null);
  }, []);
  useEffect(
    () => () => {
      addressRequest.current?.abort();
      parcelRequest.current?.abort();
      inquiryRequest.current?.abort();
    },
    [],
  );
  useEffect(() => {
    if (!addressesVisible && !parcelsVisible) return;
    const timer = setTimeout(() => {
      const bounds = globe.current?.bounds();
      let key = '';
      try {
        if (!bounds || view.height > 6500) throw new Error();
        validateBounds(bounds, 0.08);
        key = Object.values(bounds)
          .map((n) => n.toFixed(5))
          .join(',');
      } catch {
        lastArea.current = '';
        setAreaMessage(
          'Zoom closer or tilt toward the ground to load a neighborhood. Both overlays stay enabled on every map.',
        );
        addressRequest.current?.abort();
        parcelRequest.current?.abort();
        setAddresses((s) => ({ ...s, loading: false }));
        setParcels((s) => ({ ...s, loading: false }));
        return;
      }
      setAreaMessage('');
      const areaKey = `${key}:${addressesVisible}:${parcelsVisible}:${refresh}`;
      if (lastArea.current === areaKey) return;
      lastArea.current = areaKey;
      const params = new URLSearchParams(
        Object.entries(bounds as Bounds).map(([k, v]) => [k, v.toFixed(6)]),
      );
      async function load<T>(
        path: string,
        request: RefObject<AbortController | null>,
        set: (fn: (s: OverlayState<T>) => OverlayState<T>) => void,
      ) {
        request.current?.abort();
        const controller = new AbortController();
        request.current = controller;
        set((s) => ({ ...s, loading: true, error: '' }));
        try {
          const response = await fetch(`/api/${path}?${params}`, {
            signal: controller.signal,
          });
          const data = (await response.json()) as T & { error?: string };
          if (!response.ok)
            throw new Error(data.error || 'This overlay could not load.');
          if (!controller.signal.aborted)
            set(() => ({ data, loading: false, error: '' }));
        } catch (e) {
          if (!controller.signal.aborted)
            set((s) => ({
              ...s,
              loading: false,
              error:
                e instanceof Error
                  ? e.message
                  : 'The source could not be reached.',
            }));
        }
      }
      if (addressesVisible)
        void load('addresses', addressRequest, setAddresses);
      if (parcelsVisible) void load('us-parcels', parcelRequest, setParcels);
    }, 900);
    return () => clearTimeout(timer);
  }, [
    globe,
    view.lat,
    view.lon,
    view.height,
    view.heading,
    view.pitch,
    addressesVisible,
    parcelsVisible,
    refresh,
  ]);
  const setAddressesVisible = useCallback((enabled: boolean) => {
    updateAddressesVisible(enabled);
    if (!enabled) {
      lastArea.current = '';
      addressRequest.current?.abort();
      setAddresses((s) => ({ ...s, loading: false }));
    }
  }, []);
  const setParcelsVisible = useCallback((enabled: boolean) => {
    updateParcelsVisible(enabled);
    if (!enabled) {
      lastArea.current = '';
      parcelRequest.current?.abort();
      setParcels((s) => ({ ...s, loading: false }));
    }
  }, []);
  const selectMapObject = useCallback(
    (p: EarthPick) => {
      if (p.kind === 'address') {
        const a = addresses.data?.items.find((a) => a.id === p.id);
        if (a) selectAddress(a);
        return true;
      }
      if (p.kind === 'parcel') {
        const feature = parcels.data?.data.features.find(
          (f) => f.id === p.id,
        ) as LandParcelFeature | undefined;
        if (feature && p.location) {
          const a: AddressPoint = {
            id: `parcel:${feature.id}`,
            lat: p.location.lat,
            lon: p.location.lon,
            number: '',
            street:
              feature.properties.address === 'Not supplied'
                ? ''
                : feature.properties.address,
            unit: '',
            postcode: '',
            city: feature.properties.locality || '',
            country: 'US',
            label: '',
            sources: [],
            source: 'Parcel situs',
            sourceId: feature.properties.sourceId,
            parcelId: feature.properties.id,
          };
          a.label = addressLabel(a) || `Parcel ${a.parcelId}`;
          selectAddress(a);
        }
        return true;
      }
      return false;
    },
    [addresses.data, parcels.data, selectAddress],
  );
  const getData = useCallback(async () => {
    if (!selectedAddress) return;
    inquiryRequest.current?.abort();
    const controller = new AbortController();
    inquiryRequest.current = controller;
    setInquiry(null);
    setInquiryError('');
    setInquiring(true);
    let completed = false;
    try {
      const response = await fetch('/api/property', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: selectedAddress }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = (await response.json()) as { error?: string };
        throw new Error(error.error || 'The property inquiry failed.');
      }
      if (!response.body)
        throw new Error('The connection did not return a result stream.');
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let buffer = '';
      function accept(line: string) {
        if (!line.trim() || controller.signal.aborted) return;
        const event = JSON.parse(line) as InquiryEvent;
        if (event.type === 'started') setInquiry(event.value);
        else if (event.type === 'check')
          setInquiry((s) =>
            s ? { ...s, checks: [...s.checks, event.value] } : s,
          );
        else if (event.type === 'evidence')
          setInquiry((s) =>
            s ? { ...s, evidence: [...s.evidence, event.value] } : s,
          );
        else if (event.type === 'complete') {
          completed = true;
          setInquiry(event.value);
        } else if (event.type === 'error') throw new Error(event.message);
      }
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) accept(line);
        if (buffer.length > 2_000_000)
          throw new Error('The property response exceeded the display limit.');
      }
      buffer += decoder.decode();
      if (buffer.trim()) accept(buffer);
      if (!completed)
        throw new Error(
          'The connection ended before all sources finished. Partial results are shown; try Get data again.',
        );
    } catch (e) {
      if (!controller.signal.aborted)
        setInquiryError(
          e instanceof Error ? e.message : 'The property inquiry failed.',
        );
    } finally {
      if (!controller.signal.aborted) setInquiring(false);
    }
  }, [selectedAddress]);
  return {
    addressesVisible,
    setAddressesVisible,
    parcelsVisible,
    setParcelsVisible,
    addresses,
    parcels,
    selectedAddress,
    selectAddress,
    selectMapObject,
    close,
    inquiry,
    inquiryError,
    inquiring,
    getData,
    anchor,
    setAnchor,
    areaMessage,
    reload: () => setRefresh((n) => n + 1),
  };
}
export type LandExplorer = ReturnType<typeof useLandExplorer>;
