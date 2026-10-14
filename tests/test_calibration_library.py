import copy
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from backend.calibration_library import register_calibration_library, CalibrationStore


class CalibrationLibraryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'library.sqlite'
        self.role = 'owner'
        self.allowed = True
        self.datasets = [{'id': f'f{i}', 'name': f'Standard {x}', 'instrument_type': 'GCMS',
                          'instrument_name': 'GC-1', 'method': 'Method-1'} for i, x in enumerate((1, 2, 3))]
        self.peaks = {f'f{i}': [
            {'annotationId': 'a', 'compound': 'Vanillin', 'area_value': 10*x+5, 'rt_apex': 5, 'rt_left': 4, 'rt_right': 6},
            {'annotationId': 'is', 'compound': 'Internal standard', 'area_value': 10, 'rt_apex': 7, 'rt_left': 6, 'rt_right': 8},
        ] for i, x in enumerate((1, 2, 3))}
        def authorize(id, user, required):
            if id != 'source' or not self.allowed:
                raise HTTPException(403, 'Access denied')
            if required == 'editor' and self.role == 'viewer':
                raise HTTPException(403, 'Read only')
            return {'id': id}, self.role
        self.app = FastAPI()
        register_calibration_library(self.app, current_user=lambda: {'id': 'analyst'}, authorize=authorize,
                                     metadata=lambda p, **kw: {'datasets': self.datasets},
                                     annotations=lambda user, id: self.peaks[id], path=lambda: self.path)
        self.client = TestClient(self.app)
        self.profile = {'instrument': 'GC-1', 'method': 'Method-1', 'column_model': 'DB-5', 'column_phase': '5% phenyl',
                        'column_length_m': '30', 'column_id_um': '250', 'column_film_um': '0.25',
                        'response': 'TIC', 'area_multiplier': '60', 'acquisition_mode': 'Scan', 'integration': 'Linear baseline'}
        self.payload = {'project_id': 'source', 'name': 'Vanillin working range', 'compound': 'Vanillin',
                        'mode': 'external', 'unit': 'ug/mL', 'profile': self.profile, 'force_zero_manual': True,
                        'rows': [{'dataset_id': f'f{i}', 'peak_id': 'a', 'concentration': x, 'is_peak_id': 'is',
                                  'is_concentration': 2, 'excluded': False} for i, x in enumerate((1, 2, 3))]}

    def create(self, payload=None):
        response = self.client.post('/api/calibration-library', json=payload or self.payload)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def publish(self, draft):
        response = self.client.post(f"/api/calibration-library/{draft['id']}/publish",
                                    json={'revision': draft['revision'], 'confirmed': True})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def quantify(self, entry, **extra):
        return self.client.post(f"/api/calibration-library/{entry['id']}/versions/{entry['versions'][0]['version']}/quantify",
                                json={'area': 25, 'dilution': 2, 'profile': self.profile, 'concentration_unit': 'ug/mL', **extra})

    def test_automatic_intercept_and_persisted_override(self):
        draft = self.create({**self.payload, 'force_zero_manual': False})
        self.assertTrue(draft['fit']['force_zero'])
        self.assertEqual(draft['fit']['intercept'], 0)
        saved = self.client.put(f"/api/calibration-library/{draft['id']}", json={**draft, 'force_zero_manual': True, 'force_zero': False}).json()
        self.assertAlmostEqual(saved['fit']['intercept'], 5)
        reloaded = self.client.get(f"/api/calibration-library/{draft['id']}").json()
        self.assertTrue(reloaded['force_zero_manual'])
        self.assertAlmostEqual(reloaded['fit']['intercept'], 5)

    def test_external_curve_published_quantitation_and_search(self):
        draft = self.create()
        self.assertAlmostEqual(draft['fit']['slope'], 10)
        self.assertAlmostEqual(draft['fit']['intercept'], 5)
        entry = self.publish(draft)
        result = self.quantify(entry)
        self.assertEqual(result.status_code, 200, result.text)
        self.assertAlmostEqual(result.json()['value'], 4)
        self.assertAlmostEqual(result.json()['measured'], 2)
        self.assertEqual(result.json()['warnings'], [])
        self.assertEqual(self.client.get('/api/calibration-library?q=vanilin').json()['entries'][0]['published_count'], 1)
        self.assertEqual(self.client.get('/api/calibration-library?q=DB-5').json()['entries'][0]['id'], entry['id'])
        self.assertEqual(self.client.get('/api/calibration-library?q=unrelated').json()['entries'], [])

    def test_literal_lab_search_names_files_and_access(self):
        self.datasets[0]['source_name'] = '260812_25ugml_nicotine.D'
        draft = self.create()
        app = FastAPI()
        def authorize(id, user, required):
            if not self.allowed:
                raise HTTPException(403)
            return {'id': id}, 'owner'
        register_calibration_library(app, current_user=lambda: {'id': 'analyst'}, authorize=authorize,
                                     metadata=lambda p, **kw: {'datasets': self.datasets},
                                     annotations=lambda user, id: self.peaks[id], path=lambda: self.path, literal_search=True)
        client = TestClient(app)
        for query in (' VANILLIN ', '260812_25ugml_nicotine.D', 'nicotine', 'DB-5'):
            entries = client.get('/api/calibration-library', params={'q': query}).json()['entries']
            self.assertEqual([entry['id'] for entry in entries], [draft['id']])
            self.assertEqual(len(entries[0]['source_files']), 3)
        self.assertEqual(client.get('/api/calibration-library?q=vanilin').json()['entries'], [])
        self.allowed = False
        self.assertEqual(client.get('/api/calibration-library?q=nicotine').json()['entries'], [])

    def test_analyst_identity_without_nist_requires_explicit_review_and_publication(self):
        for peaks in self.peaks.values():
            peaks[0]['calibration_preparation'] = {'identity_source': 'analyst', 'identity_confirmed': False,
                'match_confirmed': False, 'area_confirmed': True, 'area_multiplier': 60, 'integration': 'endpoints'}
        blocked = self.create()
        self.assertIsNone(blocked['fit'])
        for peaks in self.peaks.values():
            peaks[0]['calibration_preparation']['identity_confirmed'] = True
        draft = self.create()
        self.assertIsNotNone(draft['fit'])
        response = self.client.post(f"/api/calibration-library/{draft['id']}/publish", json={'revision': draft['revision'], 'confirmed': False})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(len(self.publish(draft)['versions']), 1)

    def test_internal_standard_ratio_fit_and_quantitation(self):
        self.payload['mode'] = 'internal'
        draft = self.create()
        self.assertAlmostEqual(draft['fit']['slope'], 2)
        self.assertAlmostEqual(draft['fit']['intercept'], .5)
        entry = self.publish(draft)
        result = self.quantify(entry, is_area=10, is_concentration=2, is_name='Internal standard')
        self.assertEqual(result.status_code, 200, result.text)
        self.assertAlmostEqual(result.json()['value'], 4)
        for extra in [{}, {'is_area': 0}, {'is_area': 10, 'is_concentration': 0},
                      {'is_area': 10, 'is_concentration': 2, 'is_name': 'Wrong'}]:
            self.assertEqual(self.quantify(entry, **extra).status_code, 400)

    def test_publication_is_immutable_and_variants_have_provenance(self):
        entry = self.publish(self.create())
        original = copy.deepcopy(entry['versions'][0])
        self.peaks['f1'][0]['area_value'] = 100
        saved = self.client.put(f"/api/calibration-library/{entry['id']}", json={**entry, 'name': 'Updated draft'}).json()
        self.assertNotEqual(saved['fit']['slope'], 0)
        self.assertEqual(saved['versions'][0], original)
        self.assertAlmostEqual(self.quantify(saved).json()['value'], 4)
        variant = self.client.post(f"/api/calibration-library/{entry['id']}/variants", json={'version': original['version']}).json()
        self.assertEqual(variant['parent'], {'id': entry['id'], 'version': original['version']})
        self.assertEqual(variant['fit'], original['fit'])
        self.assertEqual(variant['versions'], [])
        self.assertNotEqual(variant['id'], entry['id'])

    def test_permissions_and_scope(self):
        entry = self.publish(self.create())
        self.role = 'viewer'
        self.assertFalse(self.client.get(f"/api/calibration-library/{entry['id']}").json()['editable'])
        self.assertEqual(self.client.post('/api/calibration-library', json=self.payload).status_code, 403)
        self.assertEqual(self.client.put(f"/api/calibration-library/{entry['id']}", json=entry).status_code, 403)
        self.assertEqual(self.client.post(f"/api/calibration-library/{entry['id']}/publish", json={'revision': entry['revision'], 'confirmed': True}).status_code, 403)
        self.allowed = False
        self.assertEqual(self.client.get('/api/calibration-library').json()['entries'], [])
        self.assertEqual(self.client.get(f"/api/calibration-library/{entry['id']}").status_code, 403)
        self.assertEqual(self.quantify(entry).status_code, 403)

    def test_changed_source_requires_refit_and_stale_revision_is_rejected(self):
        draft = self.create()
        self.peaks['f1'][0]['area_value'] = 30
        path = f"/api/calibration-library/{draft['id']}"
        self.assertEqual(self.client.post(path+'/publish', json={'revision': 1, 'confirmed': True}).status_code, 409)
        self.assertEqual(self.client.put(path, json={**draft, 'revision': 0}).status_code, 409)
        saved = self.client.put(path, json=draft).json()
        self.assertNotEqual(saved['fit'], draft['fit'])
        self.publish(saved)

    def test_invalid_fit_saved_as_draft_but_not_publishable(self):
        for row in self.payload['rows']:
            row['concentration'] = 1
        draft = self.create()
        self.assertIsNone(draft['fit'])
        self.assertIn('three', draft['fit_error'])
        self.assertEqual(self.client.post(f"/api/calibration-library/{draft['id']}/publish", json={'revision': 1, 'confirmed': True}).status_code, 400)

    def test_review_and_metadata_required(self):
        self.payload['profile']['column_model'] = ''
        draft = self.create()
        result = self.client.post(f"/api/calibration-library/{draft['id']}/publish", json={'revision': 1, 'confirmed': True})
        self.assertEqual(result.status_code, 400)
        self.assertIn('column model', result.text)
        self.peaks['f1'][0]['kind'] = 'auto'
        draft = self.create()
        self.assertIsNone(draft['fit'])
        self.assertIn('verify', draft['fit_error'])

    def test_duplicate_runs_identity_and_exclusions(self):
        self.payload['rows'][1]['dataset_id'] = 'f0'
        self.assertIn('same run', self.create()['fit_error'])
        self.payload['rows'][1]['dataset_id'] = 'f1'
        self.peaks['f1'][0]['compound'] = 'Other'
        self.assertIn('compound name', self.create()['fit_error'])
        self.peaks['f1'][0]['compound'] = 'Vanillin'
        self.payload['rows'].append({'excluded': True})
        self.assertIn('exclusion reason', self.create()['fit_error'])
        self.payload['rows'][-1]['reason'] = 'Injection failed'
        self.assertIsNotNone(self.create()['fit'])

    def test_incompatible_sample_and_nonfinite_inputs(self):
        entry = self.publish(self.create())
        for value in [0, -1, True, 'nan', 'inf', None]:
            self.assertEqual(self.quantify(entry, area=value).status_code, 400)
        self.assertEqual(self.quantify(entry, profile={**self.profile, 'column_model': 'Other'}).status_code, 400)
        self.assertEqual(self.quantify(entry, concentration_unit='mg/mL').status_code, 400)
        self.assertIn('Above calibration range', self.quantify(entry, area=100).json()['warnings'])
        self.assertIn('Negative estimate', self.quantify(entry, area=1).json()['warnings'])

    def test_client_area_and_fit_injection_ignored(self):
        self.payload['fit'] = {'slope': 999}
        self.payload['rows'][0]['area'] = 999999
        draft = self.create()
        self.assertAlmostEqual(draft['fit']['slope'], 10)
        self.assertEqual(draft['fit']['points'][0]['area'], 15)
        self.assertNotIn('area', draft['rows'][0])

    def test_database_concurrent_revision_is_atomic(self):
        entry = self.create()
        entry.pop('editable')
        entry.pop('versions')
        entry['revision'] += 1
        def save(_):
            try:
                CalibrationStore(lambda: self.path).save(entry, 1)
                return 200
            except HTTPException as error:
                return error.status_code
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sorted(pool.map(save, range(2))), [200, 409])

    def test_data_survives_reopening_store(self):
        entry = self.publish(self.create())
        reloaded = CalibrationStore(lambda: self.path).get(entry['id'])
        self.assertEqual(reloaded['versions'], entry['versions'])

    def test_preparation_evidence_is_published_without_converting_added_quantity_to_total(self):
        review = {'match_confirmed': True, 'area_drawn': True, 'quantity': 0,
                  'basis': 'added', 'unit': 'ug', 'area_multiplier': 60, 'integration': 'endpoints'}
        self.peaks['f0'][0]['calibration_preparation'] = review
        draft = self.create()
        self.assertEqual(draft['fit']['points'][0]['concentration'], 1)
        entry = self.publish(draft)
        self.assertEqual(entry['versions'][0]['fit']['evidence'][0]['analyte']['preparation'], review)

    def test_preparation_confirmation_and_reporting_units_are_required(self):
        review = {'match_confirmed': True, 'area_drawn': True, 'area_multiplier': 60, 'integration': 'endpoints'}
        self.peaks['f0'][0]['calibration_preparation'] = review
        for field in ('match_confirmed', 'area_drawn'):
            review[field] = False
            self.assertIn('Confirm', self.create()['fit_error'])
            review[field] = True
        review['area_multiplier'] = 1
        self.assertIn('multiplier', self.create()['fit_error'])
        review['area_multiplier'] = 60
        self.payload['profile']['integration'] = 'zero'
        self.assertIn('baseline', self.create()['fit_error'])

    def test_prepared_runs_are_durable_pending_and_project_scoped(self):
        body = {'id': 'f0', 'peaks': [{'rt_apex': 5, 'net_area': 12}], 'area_multiplier': 60}
        before = copy.deepcopy(self.peaks)
        url = '/api/calibration-library/preparations/source'
        response = self.client.post(url, json=body)
        self.assertEqual(response.status_code, 200, response.text)
        key = response.json()['preparation_id']
        self.assertEqual(self.client.post(url, json=body).json()['preparation_id'], key)
        stored = CalibrationStore(lambda: self.path).preparation(key)
        self.assertEqual(stored['review_state'], 'pending')
        self.assertEqual(stored['peaks'], body['peaks'])
        self.assertEqual(self.peaks, before)
        self.role = 'viewer'
        self.assertEqual(self.client.get(url+'/'+key).status_code, 200)
        self.assertEqual(self.client.post(url, json=body).status_code, 403)
        self.allowed = False
        self.assertEqual(self.client.get(url+'/'+key).status_code, 403)

    def test_import_is_idempotent_and_does_not_replace_reviewed_edits(self):
        self.payload['import_key'] = 'series:compound'
        draft = self.create()
        edited = self.client.put('/api/calibration-library/'+draft['id'], json={**draft, 'name': 'Reviewed name'}).json()
        repeated = self.create()
        self.assertFalse(repeated['created'])
        self.assertEqual(repeated['name'], 'Reviewed name')
        self.assertEqual(repeated['revision'], edited['revision'])

    def test_verified_auto_area_can_fit_but_unconfirmed_filename_levels_cannot(self):
        self.peaks['f0'][0]['calibration_preparation'] = {
            'match_confirmed': True, 'area_drawn': False, 'area_confirmed': True,
            'area_multiplier': 60, 'integration': 'endpoints'}
        self.assertIsNotNone(self.create()['fit'])
        self.payload['rows'][0]['quantity_confirmed'] = False
        self.assertIn('filename concentration', self.create()['fit_error'])


if __name__ == '__main__':
    unittest.main()
