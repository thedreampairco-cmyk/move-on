#!/bin/bash

# ==========================================
# MOVE-ON BOT: FORCE AUTO-PUSH SCRIPT
# ==========================================

echo "🔥 Initiating Force Auto-Push sequence..."

# 1. Verify we are inside a Git repository
if [ ! -d ".git" ]; then
  echo "❌ Error: This directory is not a Git repository."
  echo "💡 Fix: Run 'git init' and link your remote origin first."
  exit 1
fi

# 2. Set the commit message (Uses argument $1 if provided, else defaults)
COMMIT_MSG=${1:-"Auto-update: Move-On Bot architecture sync"}

# 3. Stage all changes
echo "📦 Staging all files..."
git add .

# 4. Commit changes
echo "💾 Committing: '$COMMIT_MSG'"
git commit -m "$COMMIT_MSG"

# 5. Force push to the remote repository (assumes 'main' branch)
echo "🚀 Force pushing to origin main..."
if git push -f origin main; then
    echo "✅ Success: Repository force-synced."
else
    echo "❌ Error: Push failed. Check your network or Git credentials."
    exit 1
fi
