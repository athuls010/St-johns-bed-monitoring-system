import sys
import os

# Add the project root to the path so we can find the backend module
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.app import app

# Vercel needs the app object to be named 'app'
# and it will handle the serving
if __name__ == "__main__":
    app.run()
