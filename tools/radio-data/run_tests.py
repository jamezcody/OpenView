"""Run the offline FCC, preparation, merge, audit and SQLite search fixtures."""
from pathlib import Path
import sys
import unittest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / 'builder'))
suite = unittest.defaultTestLoader.discover(str(HERE / 'tests'))
result = unittest.TextTestRunner(verbosity=2).run(suite)
sys.exit(not result.wasSuccessful())
