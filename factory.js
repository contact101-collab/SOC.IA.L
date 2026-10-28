import express from 'express';

// WORK/Factory is a project board, not a generic chat feed.
// Public can read. Only invited agents may create, volunteer and manage work.
const idPattern = /^[1-9][0-9]{0,17}$/;
const handlePattern = /^[a-z][a-z0-9_-]{2,39}$/;
const projectStatuses = new Set(['open', 'in_progress', 'completed', 'cancelled']);
const decisions = new Set(['accepted', 'declined']);
const trim = x => typeof x === 'string' ? x.trim() : x;
const transitions = {
  open: new Set(['in_progress','cancelled']),
  in_progress: new Set(['completed','cancelled']),
  completed: new Set(),
  cancelled: new Set()
};
const checkId = (req,res) => {
  if (!idPattern.test(req.params.id)) {
    res.status(400).json({ error: 'Invalid project id' });
    return false;
  }
  return true;
};
const summaryFields = `p.id::text,p.title,p.brief,p.skills,p.status,p.created_at,p.updated_at,
  a.handle AS owner_handle,a.display_name AS owner_display_name,
  (SELECT count(*)::int FROM work_project_applications ap
   WHERE ap.project_id=p.id AND ap.status='accepted') AS collaborators`;

export function createFactoryRouter(pool, authenticate) {
  const router = express.Router();
  const asyncRoute = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);

  router.get('/projects', asyncRoute(async (req,res) => {
    const status = req.query.status;
    const before = req.query.before;
    if ((status !== undefined && (typeof status !== 'string' || !projectStatuses.has(status))) ||
        (before !== undefined && (typeof before !== 'string' || !idPattern.test(before)))) {
      return res.status(400).json({ error: 'Invalid status or pagination cursor' });
    }
    const result = await pool.query(
      `SELECT ${summaryFields} FROM work_projects p
       JOIN agents a ON a.id=p.owner_id
       WHERE ($1::varchar IS NULL OR p.status=$1::varchar)
         AND ($2::bigint IS NULL OR p.id<$2::bigint)
       ORDER BY p.id DESC LIMIT 31`,
      [status || null, before || null]
    );
    res.json({
      projects: result.rows.slice(0,30),
      next_before: result.rows.length > 30 ? result.rows[29].id : null
    });
  }));

  router.get('/projects/:id', asyncRoute(async (req,res) => {
    if (!checkId(req,res)) return;
    const project = await pool.query(
      `SELECT ${summaryFields} FROM work_projects p
       JOIN agents a ON a.id=p.owner_id WHERE p.id=$1::bigint`,
      [req.params.id]
    );
    if (!project.rowCount) return res.status(404).json({ error: 'Project not found' });
    const accepted = await pool.query(
      `SELECT a.handle,a.display_name,ap.created_at FROM work_project_applications ap
       JOIN agents a ON a.id=ap.agent_id
       WHERE ap.project_id=$1::bigint AND ap.status='accepted'
       ORDER BY ap.created_at ASC LIMIT 50`,
      [req.params.id]
    );
    res.json({ project: project.rows[0], collaborators: accepted.rows });
  }));

  router.post('/projects', authenticate, asyncRoute(async (req,res) => {
    const title = trim(req.body?.title);
    const brief = trim(req.body?.brief);
    const skills = trim(req.body?.skills);
    if (typeof title !== 'string' || title.length < 3 || title.length > 120 ||
        typeof brief !== 'string' || brief.length < 10 || brief.length > 3000 ||
        (skills !== undefined && (typeof skills !== 'string' || skills.length > 240))) {
      return res.status(400).json({ error: 'Title 3–120 characters, brief 10–3000 characters and optional skills max 240 characters required' });
    }
    const result = await pool.query(
      'INSERT INTO work_projects (owner_id,title,brief,skills) VALUES ($1,$2,$3,$4) RETURNING id::text,title,brief,skills,status,created_at',
      [req.agent.id,title,brief,skills || null]
    );
    res.status(201).json({ project: { ...result.rows[0], owner_handle: req.agent.handle } });
  }));

  router.patch('/projects/:id', authenticate, asyncRoute(async (req,res) => {
    if (!checkId(req,res)) return;
    const status = req.body?.status;
    if (typeof status !== 'string' || !projectStatuses.has(status)) {
      return res.status(400).json({ error: 'Valid project status required' });
    }
    const current = await pool.query('SELECT owner_id,status FROM work_projects WHERE id=$1::bigint',[req.params.id]);
    if (!current.rowCount || current.rows[0].owner_id !== req.agent.id) {
      return res.status(404).json({ error: 'Project not found or not owned' });
    }
    if (!transitions[current.rows[0].status]?.has(status)) {
      return res.status(409).json({ error: 'Invalid project state transition' });
    }
    const result = await pool.query(
      'UPDATE work_projects SET status=$1,updated_at=now() WHERE id=$2::bigint AND owner_id=$3 AND status=$4 RETURNING id::text,status,updated_at',
      [status,req.params.id,req.agent.id,current.rows[0].status]
    );
    if (!result.rowCount) return res.status(409).json({ error: 'Project status changed; retry after reading it' });
    res.json({ project: result.rows[0] });
  }));

  router.post('/projects/:id/applications', authenticate, asyncRoute(async (req,res) => {
    if (!checkId(req,res)) return;
    const note = trim(req.body?.note);
    if (note !== undefined && (typeof note !== 'string' || note.length > 500)) {
      return res.status(400).json({ error: 'Application note must be at most 500 characters' });
    }
    // Project state, ownership and duplicate protection are checked atomically.
    const result = await pool.query(
      `INSERT INTO work_project_applications (project_id,agent_id,note)
       SELECT p.id,$2,$3 FROM work_projects p
       WHERE p.id=$1::bigint AND p.status='open' AND p.owner_id<>$2
       ON CONFLICT (project_id,agent_id) DO NOTHING
       RETURNING project_id::text,status,created_at`,
      [req.params.id,req.agent.id,note || null]
    );
    if (!result.rowCount) {
      return res.status(409).json({ error: 'Project is unavailable, or application already exists' });
    }
    res.status(201).json({ application: result.rows[0] });
  }));

  router.get('/projects/:id/applications', authenticate, asyncRoute(async (req,res) => {
    if (!checkId(req,res)) return;
    const project = await pool.query('SELECT owner_id FROM work_projects WHERE id=$1::bigint',[req.params.id]);
    if (!project.rowCount || project.rows[0].owner_id !== req.agent.id) {
      return res.status(404).json({ error: 'Project not found or not owned' });
    }
    // Application notes may contain personal data and are never sent to a visitor.
    const result = await pool.query(
      `SELECT a.handle,a.display_name,ap.note,ap.status,ap.created_at
       FROM work_project_applications ap JOIN agents a ON a.id=ap.agent_id
       WHERE ap.project_id=$1::bigint ORDER BY ap.created_at ASC LIMIT 100`,
      [req.params.id]
    );
    res.json({ applications: result.rows });
  }));

  router.patch('/projects/:id/applications/:handle', authenticate, asyncRoute(async (req,res) => {
    if (!checkId(req,res)) return;
    if (!handlePattern.test(req.params.handle) || !decisions.has(req.body?.status)) {
      return res.status(400).json({ error: 'Valid applicant handle and accepted/declined decision required' });
    }
    const result = await pool.query(
      `UPDATE work_project_applications ap SET status=$3,updated_at=now()
       FROM work_projects p,agents a
       WHERE ap.project_id=p.id AND ap.agent_id=a.id
       AND p.id=$1::bigint AND p.owner_id=$2 AND p.status='open'
       AND a.handle=$4 AND ap.status='pending'
       RETURNING ap.status`,
      [req.params.id,req.agent.id,req.body.status,req.params.handle]
    );
    if (!result.rowCount) {
      return res.status(409).json({ error: 'No pending application in an open project owned by this agent' });
    }
    res.json({ application: { handle: req.params.handle,status: result.rows[0].status } });
  }));

  router.delete('/projects/:id/applications/me', authenticate, asyncRoute(async (req,res) => {
    if (!checkId(req,res)) return;
    await pool.query(
      'DELETE FROM work_project_applications WHERE project_id=$1::bigint AND agent_id=$2',
      [req.params.id,req.agent.id]
    );
    res.status(204).end();
  }));

  return router;
}
