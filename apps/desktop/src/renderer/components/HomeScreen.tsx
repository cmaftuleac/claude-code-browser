import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle, FolderOpen, Plus } from 'lucide-react';
import { useRecentsStore } from '../stores/recents-store';
import { useWorkspaceStore } from '../stores/workspace-store';
import { RecentProjectRow } from './RecentProjectRow';
import { NewProjectView } from './NewProjectView';

const ANIM = { duration: 0.22, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] };

type HomeView = 'list' | 'new-project';

export function HomeScreen() {
  const recents = useRecentsStore((s) => s.items);
  const removeRecent = useRecentsStore((s) => s.remove);
  const openFolder = useWorkspaceStore((s) => s.openFolder);
  const openError = useWorkspaceStore((s) => s.openError);
  const clearOpenError = useWorkspaceStore((s) => s.clearOpenError);
  const isElectron = window.ccb.isElectron;
  const [view, setView] = useState<HomeView>('list');
  const [webPath, setWebPath] = useState('');

  const go = (target: HomeView, _dir?: 'push' | 'pop'): void => { setView(target); };

  return (
    <div className="home">
      <div className="home__stage">
        {view === 'list' && (
          <div className="home__column">
              <div className="home__label">CLAUDE-CODE-BROWSER</div>
              <h1 className="home__heading">Open a project</h1>
              <p className="home__sub">Pick a folder to start, or create a new one.</p>

              <div className="home__actions">
                <motion.button
                  className="home-action home-action--primary"
                  whileHover={{ y: -1 }}
                  transition={ANIM}
                  onClick={() => {
                    if (isElectron) {
                      void openFolder();
                    } else if (webPath.trim()) {
                      void openFolder(webPath.trim());
                    }
                  }}
                  disabled={!isElectron && !webPath.trim()}
                >
                  <span className="home-action__icon"><FolderOpen size={18} strokeWidth={1.75} /></span>
                  <span className="home-action__body">
                    <span className="home-action__title">Open folder</span>
                    <span className="home-action__hint">{isElectron ? 'From anywhere on disk' : 'Enter a server-side path below'}</span>
                  </span>
                </motion.button>

                <motion.button
                  className="home-action"
                  whileHover={{ y: -1 }}
                  transition={ANIM}
                  onClick={() => go('new-project', 'push')}
                >
                  <span className="home-action__icon"><Plus size={18} strokeWidth={1.75} /></span>
                  <span className="home-action__body">
                    <span className="home-action__title">New project</span>
                    <span className="home-action__hint">Create an empty folder</span>
                  </span>
                </motion.button>
              </div>

              {!isElectron && (
                <input
                  className="home__path-input"
                  value={webPath}
                  onChange={(e) => setWebPath(e.target.value)}
                  placeholder="/path/to/project (server-side)"
                  spellCheck={false}
                  onKeyDown={(e) => { if (e.key === 'Enter' && webPath.trim()) void openFolder(webPath.trim()); }}
                />
              )}

              <AnimatePresence>
                {openError && (
                  <motion.div
                    key="open-error"
                    initial={{ opacity: 0, y: -4, height: 0 }}
                    animate={{ opacity: 1, y: 0, height: 'auto' }}
                    exit={{ opacity: 0, y: -4, height: 0 }}
                    transition={ANIM}
                    className="home__error"
                    onClick={clearOpenError}
                    title="Dismiss"
                  >
                    <AlertTriangle size={13} strokeWidth={1.75} />
                    <span>{openError}</span>
                  </motion.div>
                )}
              </AnimatePresence>

              <div className="home__recent-label">RECENT</div>
              <div className="home__recents">
                {recents.length === 0 && (
                  <div className="home__recents-empty">No recent projects — open or create one above.</div>
                )}
                <AnimatePresence initial={false}>
                  {recents.map((item, i) => (
                    <RecentProjectRow
                      key={item.path}
                      item={item}
                      index={i}
                      onOpen={() => void openFolder(item.path)}
                      onRemove={() => void removeRecent(item.path)}
                    />
                  ))}
                </AnimatePresence>
              </div>
          </div>
        )}

        {view === 'new-project' && (
          <div className="home__column">
            <NewProjectView onBack={() => go('list', 'pop')} />
          </div>
        )}
      </div>

      <div className="home__footer">claude-code-browser</div>
    </div>
  );
}
