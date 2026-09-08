"""FCC fixtures exercise record identity, current-version joins and source status.

The pipe headers/positions match the public ULS HD/LO/AN/FR layouts and the
September 2026 LMS archive; no network access is needed to run these checks.
"""
import csv
import io
import json
import shutil
import unittest
import uuid
import zipfile
from pathlib import Path

from adapters import parse_uls
from core import Context, Dataset
from lms import parse_lms


def uls_row(kind, size, values):
    row=['']*size;row[0]=kind
    for index,value in values.items():row[index]=str(value)
    return '|'.join(row)+'\n'


LMS_COLUMNS={
    'application':['aapp_application_id','aapp_callsign','aapp_file_num','aapp_expiration_date','active_ind'],
    'application_facility':['afac_application_id','afac_facility_id','licensee_name','country_code','afac_channel','am_frequency','afac_facility_type','active_ind'],
    'license_filing_version':['filing_version_id','current_status_code','auth_type_code','active_ind','service_code','status_date'],
    'app_location':['aloc_aapp_application_id','aloc_loc_record_id','aloc_lat_deg','aloc_lat_mm','aloc_lat_ss','aloc_lat_dir','aloc_long_deg','aloc_long_mm','aloc_long_ss','aloc_long_dir','aloc_active_ind'],
    'app_antenna':['aant_aloc_loc_record_id','aant_antenna_record_id','aant_rc_hag','aant_true_deg','aant_active_ind'],
    'app_antenna_frequency':['aafq_aant_antenna_record_id','aafq_frequency_record_id','aafq_frequency_assigned_mhz','aafq_channel','aafq_trans_power_output_kw','aafq_active_ind'],
}


def lms_archive(path, filings):
    tables={name:[] for name in LMS_COLUMNS}
    for index,spec in enumerate(filings,1):
        app=spec.get('id',f'{index:032x}')
        tables['application'].append([app,spec.get('call_sign','WTEST'),spec.get('file_number',f'0000{index:06d}'),
                                      spec.get('expiry','2031-08-01 00:00:00.0'),spec.get('application_active','Y')])
        tables['application_facility'].append([app,spec.get('facility','12345'),'Test Broadcasting, Inc.',
                                               spec.get('country','US'),'254',spec.get('am_frequency',''),'MAIN',spec.get('facility_active','Y')])
        tables['license_filing_version'].append([app,spec.get('status','GRA'),spec.get('auth_type','L'),
                                                spec.get('filing_active','Y'),spec.get('service','FM'),'2026-08-01 00:00:00.0'])
        for location,frequency in enumerate(spec.get('frequencies',[98.7]),1):
            loc=f'{app}-loc-{location}';ant=f'{app}-ant-{location}'
            tables['app_location'].append([app,loc,39+location,0,0,'N',74,0,0,'W',spec.get('location_active','Y')])
            tables['app_antenna'].append([loc,ant,10*location,90,spec.get('antenna_active','Y')])
            tables['app_antenna_frequency'].append([ant,ant+'-freq',frequency,'254',2.5,spec.get('frequency_active','Y')])
    with zipfile.ZipFile(path,'w') as archive:
        for name,columns in LMS_COLUMNS.items():
            text=io.StringIO();writer=csv.writer(text,delimiter='|',lineterminator='\n')
            writer.writerow(columns);writer.writerows(tables[name]);archive.writestr(name+'.dat',text.getvalue())


class FccAdapterTests(unittest.TestCase):
    def setUp(self):
        self.parent=Path(__file__).resolve().parent/'tmp'
        self.folder=self.parent/uuid.uuid4().hex;self.folder.mkdir(parents=True)
        self.ctx=Context(self.folder,lambda _:None)

    def tearDown(self):
        assert self.folder.resolve().is_relative_to(self.parent.resolve())
        shutil.rmtree(self.folder)

    def uls_archive(self, statuses):
        tables={name:[] for name in ('HD','EN','LO','AN','FR')}
        for identifier,state in enumerate(statuses,100):
            tables['HD'].append(uls_row('HD',59,{1:identifier,4:f'WQ{identifier}',5:state,6:'MG',7:'01/01/2000',8:'01/01/2001',9:'02/01/2001' if state=='C' else ''}))
            tables['EN'].append(uls_row('EN',31,{1:identifier,5:'L',7:f'Licensee {identifier}'}))
            # Every license reuses its own location 1 and antenna 1: cross-license
            # joins must not multiply rows or attach another licensee's metadata.
            tables['LO'].append(uls_row('LO',51,{1:identifier,6:'F',7:'T',8:1,19:40,20:0,21:0,22:'N',23:74,24:0,25:0,26:'W'}))
            tables['AN'].append(uls_row('AN',38,{1:identifier,6:1,7:1,9:'T',11:identifier}))
            tables['FR'].append(uls_row('FR',30,{1:identifier,6:1,7:1,8:'FX',10:6000+identifier,25:1,26:1}))
        path=self.folder/'uls.zip'
        with zipfile.ZipFile(path,'w') as archive:
            for kind,rows in tables.items():archive.writestr(kind+'.dat',''.join(rows))
        return path

    def test_uls_distinguishes_license_id_from_call_sign_and_keeps_dates(self):
        path=self.uls_archive(['A','T'])
        ds=Dataset(self.folder/'uls.sqlite',self.ctx)
        try:
            parse_uls(self.ctx,ds,path,'https://data.fcc.gov/download/pub/uls/complete/l_micro.zip',self.folder/'stage.sqlite')
            rows=ds.db.execute('SELECT license_id,call_sign,operator,frequency_mhz,antenna_height_m,status,expiration_date,details_json FROM transmitters ORDER BY license_id').fetchall()
            self.assertEqual([r[:7] for r in rows],[('100','WQ100','Licensee 100',6100.,100.,'active','01/01/2001'),
                                                  ('101','WQ101','Licensee 101',6101.,101.,'inactive','01/01/2001')])
            detail=json.loads(rows[0][7]);licensing=detail['licensing']
            self.assertEqual(licensing['identifier'],'100');self.assertEqual(licensing['identifier_kind'],'fcc_uls_unique_system_id')
            self.assertEqual(licensing['record_url'],'https://wireless2.fcc.gov/UlsApp/UlsSearch/license.jsp?licKey=100')
            self.assertEqual(detail['license_status_code'],'A');self.assertEqual(detail['grant_date'],'01/01/2000')
            # A past date does not override the FCC's reported state; renewals and
            # extensions require source evidence, not a local date heuristic.
            self.assertEqual(rows[0][5],'active')
        finally:ds.close()

    def test_uls_active_filter_excludes_terminated_and_preserves_unknowns(self):
        path=self.uls_archive(['A','T','C','E','X'])
        ds=Dataset(self.folder/'active.sqlite',self.ctx,active_only=True)
        try:
            parse_uls(self.ctx,ds,path,'https://data.fcc.gov/download/pub/uls/complete/l_micro.zip',self.folder/'stage.sqlite')
            self.assertEqual(ds.counts['transmitters'],1);self.assertEqual(ds.counts['excluded_inactive'],3)
            self.assertEqual(ds.counts['candidates'],1)
            self.assertEqual(ds.db.execute('SELECT status FROM candidates').fetchone()[0],'X')
        finally:ds.close()

    def test_lms_keeps_filing_identity_and_location_frequency_joins(self):
        path=self.folder/'lms.zip';app='25076ff39ae65435019affcc2ab9125b'
        lms_archive(path,[{'id':app,'file_number':'BLH-20010101AAA','frequencies':[98.7,99.1]},
                          {'id':'25076f91927397120192902866bc1b6c','facility':'12345','frequencies':[101.3]}])
        ds=Dataset(self.folder/'lms.sqlite',self.ctx)
        try:
            parse_lms(self.ctx,ds,path,'https://enterpriseefiling.fcc.gov/dataentry/api/download/dbfile/current.zip',self.folder/'stage.sqlite')
            rows=ds.db.execute('SELECT license_id,source_latitude,frequency_mhz,antenna_height_m,expiration_date,details_json FROM transmitters ORDER BY frequency_mhz').fetchall()
            self.assertEqual([(r[1],r[2],r[3]) for r in rows],[(40.,98.7,10.),(41.,99.1,20.),(40.,101.3,10.)])
            self.assertEqual(rows[0][0],'BLH-20010101AAA');self.assertEqual(rows[0][4],'2031-08-01 00:00:00.0')
            detail=json.loads(rows[0][5]);licensing=detail['licensing']
            self.assertEqual(detail['application_id'],app);self.assertEqual(detail['facility_id'],'12345')
            self.assertEqual(detail['filing_status_code'],'GRA');self.assertEqual(detail['authorization_type'],'L')
            self.assertEqual(licensing['identifier_kind'],'fcc_lms_filing_number');self.assertEqual(licensing['identifier_label'],'FCC LMS filing number')
            self.assertEqual(licensing['record_url'],f'https://enterpriseefiling.fcc.gov/dataentry/public/tv/draftCopy.html?appKey={app}&displayType=html')
        finally:ds.close()

    def test_lms_grants_are_separate_from_permits_and_inactive_versions(self):
        path=self.folder/'lms.zip'
        construction_permit = 'CP'
        specs=[{}, {'auth_type':construction_permit}, {'status':'PEN'}, {'country':'CA'}]
        specs.extend({field:'N'} for field in ('application_active','facility_active','filing_active','location_active','antenna_active'))
        lms_archive(path,specs);ds=Dataset(self.folder/'lms.sqlite',self.ctx,active_only=True)
        try:
            parse_lms(self.ctx,ds,path,'https://example.invalid/lms.zip',self.folder/'stage.sqlite')
            self.assertEqual(ds.counts['transmitters'],1);self.assertEqual(ds.counts['candidates'],1)
            row=ds.db.execute('SELECT status,transmission_kind,details_json FROM candidates').fetchone()
            self.assertEqual(row[:2],('granted_' + construction_permit,'unknown'));self.assertEqual(json.loads(row[2])['authorization_type'],construction_permit)
        finally:ds.close()

    def test_lms_inactive_frequencies_do_not_supply_technical_values(self):
        path=self.folder/'lms.zip'
        lms_archive(path,[{'frequency_active':'N'}, {'service':'AM','am_frequency':'1080','frequencies':['']}])
        ds=Dataset(self.folder/'lms.sqlite',self.ctx)
        try:
            parse_lms(self.ctx,ds,path,'https://example.invalid/lms.zip',self.folder/'stage.sqlite')
            rows=ds.db.execute('SELECT service,frequency_mhz,power_value FROM transmitters ORDER BY service').fetchall()
            self.assertEqual(rows,[('AM',1.08,2.5),('FM',None,None)])
        finally:ds.close()


if __name__=='__main__':unittest.main()
