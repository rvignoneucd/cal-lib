import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from backend.chromatogram_preview import cached_chromatogram, _cached


class ChromatogramPreviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(_cached.cache_clear)
        self.source = Path(self.temp.name) / 'run-test.npz'
        self.rt = [12.9, 13.0, 13.1]
        self.tic = [0.0, 75800000.0, 123.5]
        # An object spectrum would fail if accessed with allow_pickle=False.
        np.savez_compressed(self.source, rt=self.rt, tic=self.tic, intensity=np.array([object()], dtype=object))

    def test_exact_points_without_loading_spectra_and_persistent_cache(self):
        body, etag = cached_chromatogram(self.source)
        self.assertEqual(json.loads(body)['points'], [dict(x=x,y=y) for x,y in zip(self.rt,self.tic)])
        _cached.cache_clear()  # Simulate a process restart.
        with patch('backend.chromatogram_preview.np.load', side_effect=AssertionError('reparsed source')):
            self.assertEqual(cached_chromatogram(self.source), (body, etag))

    def test_rebuilt_source_invalidates_preview(self):
        body, etag = cached_chromatogram(self.source)
        np.savez_compressed(self.source, rt=self.rt, tic=[0, 10, 0])
        updated, next_etag = cached_chromatogram(self.source)
        self.assertNotEqual(body, updated)
        self.assertNotEqual(etag, next_etag)
        self.assertEqual(json.loads(updated)['points'][1]['y'], 10)
