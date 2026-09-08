import html, json, sqlite3, traceback, uuid
from collections import Counter
from datetime import datetime
from pathlib import Path
from core import Context, Dataset, Cancelled, NeedsImport, VERSION, TABLES, utc
from adapters import SOURCES, acquire, native_parse, mapped_import

def build(output,selected=None,local=None,mappings=None,refresh=False,active_only=False,log=print,cancel=None,source_options=None):
    selected=list(selected if selected is not None else (s for s,v in SOURCES.items() if v['mode']=='automatic'))
    unknown=set(selected)-set(SOURCES)
    if unknown:raise ValueError('Unknown sources: '+str(unknown))
    if not selected:raise ValueError('Select at least one source')
    ctx=Context(output,log,cancel,refresh,source_options);local=local or {};mappings=mappings or {}
    for source,options in ctx.options.items():
        for spec in SOURCES.get(source,{}).get('options',[]):
            if spec.get('secret') and options.get(spec['key']):ctx.secrets.add(str(options[spec['key']]))
    log=ctx.log
    run_id=datetime.now().strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:6]
    folder=ctx.output/'runs'/run_id;folder.mkdir(parents=True)
    ds=Dataset(folder/'dataset.sqlite',ctx,active_only)
    report={'version':VERSION,'run_id':run_id,'started_at':utc(),'status':'running','selected_sources':selected,
            'active_only':active_only,'sources':[],'downloads':ctx.downloads,'output_directory':str(folder),
            'scope':'Published transmitter and site records, not proof of present operation. Estimated or uncertain locations go to candidates; participating satellite receiving stations are separate.',
            'unselected_sources':[s for s in SOURCES if s not in selected]}
    cancelled=False
    try:
        for source in selected:
            ctx.check();log('\n'+SOURCES[source]['name'])
            before=ds.counts.copy();ds.db.execute('SAVEPOINT source_import')
            entry={'id':source,**SOURCES[source],'status':'running','input_mode':'local import' if local.get(source) else SOURCES[source]['mode']}
            if source in ctx.options:
                secret_keys={v['key'] for v in SOURCES[source].get('options',[]) if v.get('secret')}
                entry['requested_options']={k:('REDACTED' if k in secret_keys else v) for k,v in ctx.options[source].items()}
            if local.get(source):entry['files']=[str(Path(p).resolve()) for p in local[source]];entry['coverage']='Only the supplied files; national completeness not established'
            try:
                if SOURCES[source]['mode']=='reference':raise NeedsImport('Reference only: '+SOURCES[source]['scope'])
                if source in mappings:
                    if not local.get(source):raise NeedsImport('Choose CSV files for the configured mapping')
                    for p in local[source]:mapped_import(ctx,ds,source,Path(p),mappings[source])
                else:
                    native_parse(ctx,ds,source,acquire(ctx,source,local.get(source)),folder/'stage.sqlite')
                ds.db.execute('RELEASE source_import')
                entry['counts']=dict(ds.counts-before)
                entry['status']='complete' if sum(entry['counts'].get(t,0) for t in TABLES)>0 else 'empty'
                log(f"  {entry['counts'].get('transmitters',0):,} transmitters; {entry['counts'].get('candidates',0):,} candidates; {entry['counts'].get('receivers',0):,} receivers")
            except (Exception,Cancelled) as e:
                if cancel and cancel.is_set():e=Cancelled('Cancelled by user')
                ds.db.execute('ROLLBACK TO source_import');ds.db.execute('RELEASE source_import');ds.counts=before
                entry['status']='needs_import' if isinstance(e,NeedsImport) else ('cancelled' if isinstance(e,Cancelled) else 'failed')
                if SOURCES[source]['mode']=='reference':entry['status']='reference_only'
                entry['message']=ctx.redact(str(e));log('  '+entry['status'].upper()+': '+str(e))
                if not isinstance(e,(NeedsImport,Cancelled)):
                    (folder/(source+'-error.txt')).write_text(ctx.redact(traceback.format_exc()),encoding='utf-8')
                if isinstance(e,Cancelled):cancelled=True
            report['sources'].append(entry)
            if cancelled:break
        if cancelled:raise Cancelled('Cancelled; completed source data retained in this run')
        ds.finish();ds.export(folder)
        complete=all(s['status'] in ('complete','reference_only') for s in report['sources'])
        nonempty=sum(ds.counts[t] for t in TABLES)>0
        report['status']=('complete' if complete else 'partial') if nonempty else 'failed'
    except Cancelled as e:
        cancelled=True;report['status']='cancelled';report['message']=str(e);ds.db.commit()
    except Exception as e:
        report['status']='failed';report['message']=ctx.redact(str(e))
        (folder/'run-error.txt').write_text(ctx.redact(traceback.format_exc()),encoding='utf-8');log('Build failed: '+str(e))
    finally:
        report['counts']=dict(ds.counts);report['finished_at']=utc()
        ds.close()
        stage=folder/'stage.sqlite'
        if stage.exists():stage.unlink()
        (folder/'report.json').write_text(json.dumps(report,indent=2,ensure_ascii=False),encoding='utf-8')
        write_report(folder,report)
        # Only publish a pointer after a nonempty export completes. Earlier runs stay intact.
        if report['status'] in ('complete','partial'):
            tmp=ctx.output/'latest.json.tmp';tmp.write_text(json.dumps({'run_directory':str(folder),'status':report['status']},indent=2),encoding='utf-8');tmp.replace(ctx.output/'latest.json')
        log('\n'+report['status'].upper()+' — '+str(folder/'report.html'))
    return report

def write_report(folder,r):
    e=lambda x:html.escape(str(x))
    rows=''.join('<tr><td>'+e(s['name'])+'</td><td>'+e(s['status'])+'</td>'+''.join('<td>'+e(s.get('counts',{}).get(t,0))+'</td>' for t in TABLES)+'<td>'+e(s.get('message') or s.get('coverage') or s['scope'])+'</td></tr>' for s in r['sources'])
    counts=''.join('<li>'+e(k.replace('_',' '))+': <b>'+e(f'{v:,}')+'</b></li>' for k,v in r.get('counts',{}).items())
    attribution=''.join('<li><a href="'+e(s['url'])+'">'+e(s['name'])+'</a>: '+e(s.get('attribution','See publisher for attribution and reuse terms'))+'; '+e(s.get('license','Publisher terms apply'))+'</li>' for s in r['sources'])
    text=f'''<!doctype html><html lang="en"><meta charset="utf-8"><title>Transmitter dataset report</title>
    <style>body{{font:16px system-ui;max-width:1150px;margin:48px auto;padding:0 24px;color:#142638;background:#f6f8fb}}h1{{font-size:34px}}table{{border-collapse:collapse;background:white;width:100%}}td,th{{text-align:left;padding:14px;border-bottom:1px solid #dae2eb;vertical-align:top}}a{{color:#075da3}}.tag{{background:#dfeaf5;padding:6px 14px;border-radius:5px}}li{{margin:7px 0}}</style>
    <h1>Transmitter dataset</h1><p><span class="tag">{e(r['status'].upper())}</span> &nbsp; {e(r['run_id'])}</p>
    <p>{e(r['scope'])}</p><p>Coordinates with an unspecified source datum are retained for approximate mapping; see coordinate_note. A row describes an authorization / antenna / frequency record, not a count of physical transmitters.</p>
    <p><a href="dataset.sqlite">SQLite database</a> · <a href="transmitters.csv">Transmitters CSV</a> · <a href="candidates.csv">Estimated / uncertain records CSV</a> · <a href="receivers.csv">Receiving stations CSV</a> · <a href="transmitters.geojsonl">GeoJSON sequence</a> · <a href="report.json">Full provenance report</a></p>
    <p>{e(r.get('message',''))}</p><ul>{counts}</ul><table><thead><tr><th>Source</th><th>Result</th><th>Transmitters</th><th>Candidates</th><th>Receivers</th><th>Coverage / action needed</th></tr></thead><tbody>{rows}</tbody></table>
    <h2>Sources and attribution</h2><ul>{attribution}</ul>
    <p>Sources not selected: {e(', '.join(r['unselected_sources']) or 'none')}. Each run is a new snapshot. Previous runs are preserved.</p></html>'''
    (folder/'report.html').write_text(text,encoding='utf-8')
