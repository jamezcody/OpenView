import {
  safeRadioUrl,
  type RadioRecord,
  type RadioSource,
} from './radio-model';

export type RadioAuthorization = {
  identifiers: { label: string; value: string }[];
  missingReason: string | null;
  note: string;
  sourceUrl: string | undefined;
};

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const identifier = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
};

const missingReasons: Record<string, string> = {
  global_ourairports: 'Not included in OurAirports navigation-aid data.',
  global_hfcc: 'Not included in HFCC schedule data.',
  global_satnogs: 'Not included in the SatNOGS receiving-station catalog.',
  global_osm: 'Not included in the imported OpenStreetMap structure records.',
  global_opencellid: 'Not included in OpenCellID measurement data.',
  cl_subtel: 'Not included in the imported SUBTEL antenna-location workbook.',
  fi_traficom: 'Not supplied in this Traficom record.',
  pl_uke: 'Not supplied in this UKE permit record.',
  us_uls: 'FCC ULS unique system ID not supplied for this source record.',
  us_lms: 'FCC LMS filing number not supplied for this source record.',
};

const identifierLabels: Record<string, string> = {
  us_uls: 'FCC ULS unique system ID',
  us_lms: 'FCC LMS filing number',
  fi_traficom: 'License number',
  pl_uke: 'Permit / decision number',
  fr_anfr: 'ANFR station identifier',
  ch_bakom: 'SFN identifier',
  br_anatel: 'Fistel service identifier',
};

/** Interpret identifiers using their publisher's schema, including older snapshots. */
export function radioAuthorization(
  record: Pick<
    RadioRecord,
    'source' | 'license_id' | 'details_json' | 'source_url'
  >,
  source?: Pick<RadioSource, 'url'>,
): RadioAuthorization {
  const details = object(record.details_json);
  const licensing = object(details.licensing);
  const primary =
    identifier(licensing.identifier) || identifier(record.license_id);
  const identifiers: RadioAuthorization['identifiers'] = [];
  if (primary) {
    identifiers.push({
      label:
        identifierLabels[record.source] ||
        'Source license / authorization identifier',
      value: primary,
    });
  }
  if (record.source === 'us_lms') {
    for (const [key, label] of [
      ['facility_id', 'FCC facility ID'],
      ['application_id', 'FCC LMS application ID'],
    ]) {
      const value = identifier(details[key]);
      if (value) identifiers.push({ label, value });
    }
  }
  return {
    identifiers,
    missingReason: primary
      ? null
      : missingReasons[record.source] || 'Not provided by this source.',
    note: !primary
      ? 'Missing information does not mean the station is unlicensed.'
      : record.source === 'us_lms'
        ? 'A filing number identifies an application; it is not a license number. See the recorded authorization type and status in source details.'
        : 'Source identifiers and dates do not verify current authorization validity or on-air operation.',
    sourceUrl:
      safeRadioUrl(licensing.record_url) ||
      safeRadioUrl(record.source_url) ||
      safeRadioUrl(source?.url),
  };
}
