from urllib.parse import urlencode
from core import Stage, dms, number, clean
from adapters import base, member

def parse_lms(ctx,ds,path,url,stage_path):
    st=Stage(stage_path,ctx)
    tables={
      'application':['aapp_application_id','aapp_callsign','aapp_file_num','aapp_expiration_date','active_ind'],
      'application_facility':['afac_application_id','afac_facility_id','licensee_name','country_code','afac_channel','am_frequency','afac_facility_type','active_ind'],
      'license_filing_version':['filing_version_id','current_status_code','auth_type_code','active_ind','service_code','status_date'],
      'app_location':['aloc_aapp_application_id','aloc_loc_record_id','aloc_lat_deg','aloc_lat_mm','aloc_lat_ss','aloc_lat_dir','aloc_long_deg','aloc_long_mm','aloc_long_ss','aloc_long_dir','aloc_active_ind'],
      'app_antenna':['aant_aloc_loc_record_id','aant_antenna_record_id','aant_rc_hag','aant_true_deg','aant_active_ind'],
      'app_antenna_frequency':['aafq_aant_antenna_record_id','aafq_frequency_record_id','aafq_frequency_assigned_mhz','aafq_channel','aafq_trans_power_output_kw','aafq_active_ind']
    }
    try:
        for name,cols in tables.items():st.load(name,path,member(path,name+'.dat'),cols,delimiter='|')
        for name,cols in [('application',['aapp_application_id']),('application_facility',['afac_application_id']),('license_filing_version',['active_ind','current_status_code','filing_version_id']),('app_location',['aloc_aapp_application_id','aloc_active_ind']),('app_antenna',['aant_aloc_loc_record_id','aant_active_ind']),('app_antenna_frequency',['aafq_aant_antenna_record_id'])]:st.index(name,cols)
        q='''SELECT a.*,f.*,v.*,l.*,n.*,q.* FROM application a
          JOIN application_facility f ON a.aapp_application_id=f.afac_application_id
          JOIN license_filing_version v ON a.aapp_application_id=v.filing_version_id
          JOIN app_location l ON a.aapp_application_id=l.aloc_aapp_application_id
          JOIN app_antenna n ON l.aloc_loc_record_id=n.aant_aloc_loc_record_id
          LEFT JOIN app_antenna_frequency q ON n.aant_antenna_record_id=q.aafq_aant_antenna_record_id AND q.aafq_active_ind='Y'
          WHERE f.country_code='US' AND v.active_ind='Y' AND v.current_status_code='GRA'
          AND a.active_ind='Y' AND f.active_ind='Y'
          AND l.aloc_active_ind='Y' AND n.aant_active_ind='Y' '''
        for r in st.query(q):
            key=':'.join(str(r[k] or '') for k in ('aapp_application_id','afac_facility_id','aloc_loc_record_id','aant_antenna_record_id','aafq_frequency_record_id'))
            out=base('us_lms',key,'app_antenna_frequency.dat',url)
            freq=number(r['aafq_frequency_assigned_mhz'])
            if freq is None and r['service_code']=='AM':freq=(number(r['am_frequency']) or 0)/1000
            # A filing number identifies this application/authorization version;
            # it must not be presented as a broadcast station's license number.
            authorization={'authority':'FCC','system':'LMS','identifier_kind':'fcc_lms_filing_number',
                           'identifier_label':'FCC LMS filing number','identifier':clean(r['aapp_file_num'])}
            if clean(r['aapp_application_id']):
                authorization['record_url']='https://enterpriseefiling.fcc.gov/dataentry/public/tv/draftCopy.html?'+urlencode({'appKey':r['aapp_application_id'],'displayType':'html'})
            out.update(license_id=r['aapp_file_num'],call_sign=r['aapp_callsign'],operator=r['licensee_name'],site_id=r['aloc_loc_record_id'],antenna_id=r['aant_antenna_record_id'],
                       latitude=dms(r['aloc_lat_deg'],r['aloc_lat_mm'],r['aloc_lat_ss'],r['aloc_lat_dir']),
                       longitude=dms(r['aloc_long_deg'],r['aloc_long_mm'],r['aloc_long_ss'],r['aloc_long_dir']),source_crs='EPSG:4269',
                       frequency_mhz=freq,power_value=r['aafq_trans_power_output_kw'],power_unit='kW',antenna_height_m=r['aant_rc_hag'],azimuth_deg=r['aant_true_deg'],
                       status='active' if r['auth_type_code']=='L' else 'granted_'+str(r['auth_type_code']),expiration_date=r['aapp_expiration_date'],service=r['service_code'],
                       location_kind='fixed',transmission_kind='transmit' if r['auth_type_code']=='L' else 'unknown',
                       details_json={'licensing':authorization,'application_id':r['aapp_application_id'],
                                     'facility_id':r['afac_facility_id'],'channel':r['aafq_channel'] or r['afac_channel'],
                                     'authorization_type':r['auth_type_code'],'filing_status_code':r['current_status_code'],
                                     'status_date':r['status_date']})
            ds.add(out)
    finally:st.close()
