// Section 1: Supabase client setup
const SUPABASE_URL = 'https://ysrkcykscwpotwwegvrl.supabase.co'; 
const SUPABASE_ANON_KEY = 'sb_publishable_MVU9KG_4C8wkWFjiDD3kHQ_aaBRY5TL'; 

let supabaseClient = null;

// Connect to live Supabase backend when page loads
if (SUPABASE_URL && SUPABASE_URL.startsWith('https://') && SUPABASE_ANON_KEY && typeof supabase !== 'undefined') {
    try {
        supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        console.log('⚡ Connected Live to Supabase Backend Database!');
    } catch (e) {
        console.warn('Supabase Client Connection Warning:', e);
    }
}

// Section 2: Main app state central unit holds everything who is logged in what skills they picked 
const state = {
    // Current logged-in student profile
    currentUser: {
        id: null,
        full_name: '',
        email: '',
        degree_course: '',
        offered: [], // Skill IDs offered by active student
        wanted: []   // Skill IDs desired by active student
    },

    // Skill cloud controls
    cloudMode: 'offered', // 'offered' vs 'wanted'
    activeCategory: 'all',
    searchQuery: '',

    // Match choices
    acceptedCandidates: [], // Candidate IDs accepted by active student
    passedCandidates: [],   // Candidate IDs skipped by active student

    // Peer chat state
    activeChatPeerId: null,
    chatPollingTimer: null,

    // Database collections
    skills: [],   // 50 Skill objects
    profiles: [], // Campus student profiles
    messages: []  // In-app chat messages
};

// Section 3: App initialization & data loading
// Connects buttons when DOM loads and fetches skills & student profiles
document.addEventListener('DOMContentLoaded', async () => {
    initAuthFlow();
    initNavSteps();
    initSkillCloudControls();
    initChatControls();
    initBugReportingModal();

    await loadInitialData();
});

/**
 * Loads skills catalog and student profiles from Supabase database
 */

//Loads skills from supabase and student profiles
async function loadInitialData() {
    // 1. Instant fallback seed ensures UI buttons never stall
    state.skills = getDefaultSkillsSeed();
    state.profiles = getDefaultProfilesSeed();

    if (!supabaseClient) return;

    try {
        // Fetch 50 Skills from Supabase `skills` table
        const { data: dbSkills, error: skillsErr } = await supabaseClient
            .from('skills')
            .select('*')
            .order('id', { ascending: true });

        if (!skillsErr && dbSkills && dbSkills.length > 0) {
            state.skills = dbSkills;
        }

        // Fast batch fetch of student profiles & skill mappings
        await refreshLiveProfilesFromSupabase();
        renderSkillCloud();
    } catch (err) {
        console.error('Error fetching data from Supabase:', err);
    }
}

// Batch queries: fetches profiles and skills in 3 requests instead of 100 loop queries
async function refreshLiveProfilesFromSupabase() {
    if (!supabaseClient) return;

    try {
        // Query campus student profiles
        const { data: dbProfiles, error: profErr } = await supabaseClient
            .from('profiles')
            .select('*');

        if (profErr || !dbProfiles || dbProfiles.length === 0) return;

        // Query offered & wanted skills in 2 batch requests
        const { data: allOffered } = await supabaseClient.from('user_skills_offered').select('*');
        const { data: allWanted } = await supabaseClient.from('user_skills_wanted').select('*');

        // Fast in-memory relational joining
        for (const p of dbProfiles) {
            p.offered = allOffered ? allOffered.filter(o => o.user_id === p.id).map(o => o.skill_id) : [];
            p.wanted = allWanted ? allWanted.filter(w => w.user_id === p.id).map(w => w.skill_id) : [];
        }

        state.profiles = dbProfiles;
    } catch (e) {
        console.error('Error refreshing profiles from Supabase:', e);
    }
}

// Reloads accepted student matches and skill choices upon login or refresh
async function loadUserDecisionsAndSkills() {
    if (!state.currentUser.email) return;

    // Restore from LocalStorage fallback cache
    try {
        const savedAcc = localStorage.getItem(`accepted_${state.currentUser.email}`);
        if (savedAcc) state.acceptedCandidates = JSON.parse(savedAcc);
        const savedPas = localStorage.getItem(`passed_${state.currentUser.email}`);
        if (savedPas) state.passedCandidates = JSON.parse(savedPas);
    } catch (e) {}

    if (!supabaseClient || !state.currentUser.id) {
        document.getElementById('accepted-count-badge').textContent = state.acceptedCandidates.length;
        return;
    }

    try {
        const userId = state.currentUser.id;

        // Fetch user offered & wanted skills from Supabase
        const { data: off } = await supabaseClient.from('user_skills_offered').select('skill_id').eq('user_id', userId);
        const { data: wan } = await supabaseClient.from('user_skills_wanted').select('skill_id').eq('user_id', userId);
        if (off && off.length > 0) state.currentUser.offered = off.map(o => o.skill_id);
        if (wan && wan.length > 0) state.currentUser.wanted = wan.map(w => w.skill_id);

        // Fetch accepted and passed match choices from Supabase `match_decisions`
        const { data: decisions } = await supabaseClient.from('match_decisions').select('*').eq('user_id', userId);
        if (decisions && decisions.length > 0) {
            state.acceptedCandidates = decisions.filter(d => d.status === 'accepted').map(d => d.candidate_id);
            state.passedCandidates = decisions.filter(d => d.status === 'passed').map(d => d.candidate_id);
        }

        // Save to LocalStorage cache
        localStorage.setItem(`accepted_${state.currentUser.email}`, JSON.stringify(state.acceptedCandidates));
        localStorage.setItem(`passed_${state.currentUser.email}`, JSON.stringify(state.passedCandidates));

        // Update DOM badge
        document.getElementById('accepted-count-badge').textContent = state.acceptedCandidates.length;
    } catch (err) {
        console.error('Error loading user decisions:', err);
    }
}

// Section 4: Campus email auth & security
//ahmed
// Checks if email belongs to eue.edu.eg or subdomains
function validateCampusEmail(emailInput) {
    // Reject an empty email value before validating it.
    if (!emailInput) return false;
    // Normalize whitespace and letter casing for a consistent domain check.
    const clean = emailInput.trim().toLowerCase();
    // Allow EUE email addresses and one optional EUE subdomain.
    const eueCampusRegex = /^[a-zA-Z0-9._%+-]+@([a-zA-Z0-9.-]+\.)?eue\.edu\.eg$/i;
    // Return whether the normalized address matches the approved format.
    return eueCampusRegex.test(clean);
}

function initAuthFlow() {
    // Get the login form from the page.
    const formLogin = document.getElementById('form-login');
    // Get the registration form from the page.
    const formSignup = document.getElementById('form-signup');
    // Get the button that opens the registration form.
    const btnShowSignup = document.getElementById('btn-show-signup');
    // Get the button that returns to the login form.
    const btnShowLogin = document.getElementById('btn-show-login');
    // Get the shared authentication error message element.
    const authErrorMsg = document.getElementById('auth-error-msg');
    // Get the button used to sign the student out.
    const btnLogout = document.getElementById('btn-logout');

    // Switch from the login form to the registration form.
    btnShowSignup.addEventListener('click', () => {
        // Hide the login form.
        formLogin.classList.add('hidden');
        // Display the registration form.
        formSignup.classList.remove('hidden');
        // Clear any previous authentication error.
        authErrorMsg.classList.add('hidden');
    });

    // Switch from the registration form back to the login form.
    btnShowLogin.addEventListener('click', () => {
        // Hide the registration form.
        formSignup.classList.add('hidden');
        // Display the login form.
        formLogin.classList.remove('hidden');
        // Clear any previous authentication error.
        authErrorMsg.classList.add('hidden');
    });

    // Student Login Form Submit Handler
    formLogin.addEventListener('submit', async (e) => {
        // Stop the browser from reloading the page on submission.
        e.preventDefault();
        // Hide a previous error before validating the new attempt.
        authErrorMsg.classList.add('hidden');
        // Read and trim the entered login email.
        const email = document.getElementById('login-email').value.trim();
        // Read the entered login password.
        const password = document.getElementById('login-password').value;

        // Security check for email domain
        if (!validateCampusEmail(email)) {
            // Explain why the address cannot be used.
            showAuthError('Security Check Failed: Email MUST end with @eue.edu.eg or campus subdomains (e.g. @faculty.eue.edu.eg).');
            // Stop processing an invalid login.
            return;
        }

        if (!password) {
            // Require a password before attempting authentication.
            showAuthError('Security Check Failed: Please enter your password.');
            // Stop processing when the password is missing.
            return;
        }

        // Extract the part of the email before the @ symbol.
        const namePart = email.split('@')[0];
        // Build a display name from the email username.
        const fullName = namePart.charAt(0).toUpperCase() + namePart.slice(1);

        if (supabaseClient) {
            try {
                // Sign in with the provided credentials.
                const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
                if (data && data.user) {
                    // Store the authenticated Supabase user ID.
                    state.currentUser.id = data.user.id;
                } else {
                    // Try auto sign-up if first time logging in
                    const { data: suData } = await supabaseClient.auth.signUp({ email, password });
                    if (suData && suData.user) {
                        // Store the newly created Supabase user ID.
                        state.currentUser.id = suData.user.id;
                    }
                }

                // Guaranteed profile insert in Supabase `profiles` table
                await ensureProfileInSupabase(state.currentUser.id, fullName, email, 'Student');
            } catch (err) {
                console.warn('Supabase Login Fallback:', err);
            }
        }

        // Save the login email in the local app state.
        state.currentUser.email = email;
        // Save the derived display name in the local app state.
        state.currentUser.full_name = fullName;
        
        // Open the authenticated application experience.
        await loginSuccess();
    });

    // Student Registration Form Submit Handler
    formSignup.addEventListener('submit', async (e) => {
        // Stop the browser from submitting and reloading the page.
        e.preventDefault();
        // Hide a previous error before validating this registration.
        authErrorMsg.classList.add('hidden');
        // Read and trim the student's full name.
        const name = document.getElementById('signup-name').value.trim();
        // Get the degree-program select element.
        const degreeSelect = document.getElementById('signup-degree');
        // Read the selected degree safely when the select exists.
        const degree = degreeSelect ? degreeSelect.value : '';
        // Read and trim the student's EUE email address.
        const email = document.getElementById('signup-email').value.trim();
        // Read the password selected for the new account.
        const password = document.getElementById('signup-password').value;

        // Field validation
        if (!name || name.length < 2) {
            // Tell the student to provide a valid full name.
            showAuthError('Registration Error: Please enter your full name.');
            // Stop registration when the name is invalid.
            return;
        }

        if (!degree) {
            // Tell the student to choose a degree program.
            showAuthError('Registration Error: Please select your EUE Degree Program from the dropdown.');
            // Stop registration when no degree is selected.
            return;
        }

        // Security check for email domain
        if (!validateCampusEmail(email)) {
            // Explain the EUE email requirement.
            showAuthError('Registration Denied: Email MUST end with @eue.edu.eg or campus subdomains (e.g. name@eue.edu.eg).');
            // Stop registration with an unapproved email address.
            return;
        }

        if (!password) {
            // Tell the student that a password is required.
            showAuthError('Registration Denied: Please enter a password.');
            // Stop registration without a password.
            return;
        }

        if (supabaseClient) {
            try {
                // Create the Supabase account and store profile metadata.
                const { data } = await supabaseClient.auth.signUp({
                    email,
                    password,
                    options: { data: { full_name: name, degree_course: degree } }
                });

                if (data && data.user) {
                    // Store the new authenticated user's ID.
                    state.currentUser.id = data.user.id;
                }

                // Guaranteed profile insert in Supabase `profiles` table
                await ensureProfileInSupabase(state.currentUser.id, name, email, degree);
            } catch (err) {
                console.warn('Supabase Signup Fallback:', err);
            }
        }

        // Save the student's name in local app state.
        state.currentUser.full_name = name;
        // Save the selected degree in local app state.
        state.currentUser.degree_course = degree;
        // Save the student's email in local app state.
        state.currentUser.email = email;

        // Complete login after successful registration.
        await loginSuccess();
    });

    // Logout Button Handler
    btnLogout.addEventListener('click', async () => {
        // End the active Supabase session when one exists.
        if (supabaseClient) await supabaseClient.auth.signOut();
        // Reset the local user profile to its signed-out state.
        state.currentUser = { id: null, full_name: '', email: '', degree_course: '', offered: [], wanted: [] };
        // Clear accepted match IDs for the signed-out student.
        state.acceptedCandidates = [];
        // Clear passed match IDs for the signed-out student.
        state.passedCandidates = [];

        // Return the student to the authentication screen.
        document.getElementById('auth-screen').classList.add('active');
        // Hide the skill-selection screen.
        document.getElementById('skill-cloud-screen').classList.remove('active');
        // Hide the match results screen.
        document.getElementById('matches-screen').classList.remove('active');
        // Hide the accepted-swaps screen.
        document.getElementById('accepted-screen').classList.remove('active');
        // Hide the application navigation bar.
        document.getElementById('app-nav').classList.add('hidden');
        // Hide the logged-in user header.
        document.getElementById('user-header-profile').classList.add('hidden');
    });
}

/**
 * TECHNICAL SOLUTION #3: GUARANTEED PROFILE REGISTRATION HELPER
 * Ensures user profile row is written to Supabase `profiles` table reliably.
 */
async function ensureProfileInSupabase(existingId, fullName, email, degreeCourse) {
    // Skip database work when Supabase is unavailable.
    if (!supabaseClient) return;

    try {
        // Look up an existing profile using the student's email address.
        const { data: existingProf } = await supabaseClient
            .from('profiles')
            .select('id, full_name, degree_course')
            .eq('email', email)
            .maybeSingle();

        if (existingProf) {
            // Reuse the existing profile ID.
            state.currentUser.id = existingProf.id;
            // Prefer the stored name, falling back to the supplied name.
            state.currentUser.full_name = existingProf.full_name || fullName;
            // Prefer the stored degree, falling back to the supplied degree.
            state.currentUser.degree_course = existingProf.degree_course || degreeCourse;
            // Do not create a duplicate profile.
            return;
        }

        // Prepare the data for a new student profile.
        const insertPayload = {
            full_name: fullName,
            email: email,
            degree_course: degreeCourse || 'Student'
        };
        if (existingId && existingId.length > 20) {
            // Preserve the Supabase auth ID when it is valid.
            insertPayload.id = existingId;
        }

        // Insert the new profile and request its generated record.
        const { data: newProf, error: insErr } = await supabaseClient
            .from('profiles')
            .insert([insertPayload])
            .select();

        if (!insErr && newProf && newProf.length > 0) {
            // Save the newly created profile ID in local state.
            state.currentUser.id = newProf[0].id;
        }
    } catch (err) {
        console.error('Error ensuring profile in Supabase:', err);
    }
}

function showAuthError(msg) {
    // Find the authentication error message container.
    const errorBox = document.getElementById('auth-error-msg');
    // Display the supplied error message.
    errorBox.textContent = msg;
    // Make the error message visible.
    errorBox.classList.remove('hidden');
    // Scroll the error into view for the student.
    errorBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function loginSuccess() {
    // Hide the authentication screen.
    document.getElementById('auth-screen').classList.remove('active');
    // Show the skill-selection screen.
    document.getElementById('skill-cloud-screen').classList.add('active');
    // Reveal the navigation bar for the authenticated user.
    document.getElementById('app-nav').classList.remove('hidden');

    // Reload persistent user skills & accepted matches from Supabase
    await loadUserDecisionsAndSkills();

    // Get the authenticated user's current state.
    const user = state.currentUser;
    // Build avatar initials from the student's name.
    const initials = (user.full_name || 'ST').split(' ').map(n => n[0]).join('').toUpperCase();
    // Show the initials in the header avatar.
    document.getElementById('header-avatar-initials').textContent = initials;
    // Show the student's name in the header.
    document.getElementById('header-user-name').textContent = user.full_name || 'Student';
    // Show the student's email in the header.
    document.getElementById('header-user-email').textContent = user.email;
    // Reveal the user profile header.
    document.getElementById('user-header-profile').classList.remove('hidden');

    // Render the skill cloud immediately.
    renderSkillCloud();
    // Refresh live profiles, then render the updated skill cloud.
    refreshLiveProfilesFromSupabase().then(() => renderSkillCloud());
}

// Section 5: Skill cloud selector

// Initializes controls for selecting, filtering, and searching skills
function initSkillCloudControls() {
    const modeOfferedBtn = document.getElementById('mode-offered-btn');
    const modeWantedBtn = document.getElementById('mode-wanted-btn');
    const searchInput = document.getElementById('skill-search');
    const catChips = document.querySelectorAll('.cat-chip');
    const btnSaveFind = document.getElementById('btn-save-find-matches');

    // when clicked, state.cloudMode is set to offered and button is highlighted
    modeOfferedBtn.addEventListener('click', () => {
        state.cloudMode = 'offered';
        modeOfferedBtn.classList.add('active');
        modeWantedBtn.classList.remove('active');
        // renderSkillCloud is called to update the UI based on the new mode
        renderSkillCloud();
    });

    modeWantedBtn.addEventListener('click', () => {
        state.cloudMode = 'wanted';
        modeWantedBtn.classList.add('active');
        modeOfferedBtn.classList.remove('active');
        renderSkillCloud();
    });

    searchInput.addEventListener('input', (e) => {
        // Saves the search query and converts it to lowercase
        state.searchQuery = e.target.value.toLowerCase();
        // redraws the skill cloud based on the search query
        renderSkillCloud();
    });

    // Makes each category chip clickable
    catChips.forEach(chip => {
        chip.addEventListener('click', () => {
            catChips.forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            state.activeCategory = chip.getAttribute('data-cat');
            renderSkillCloud();
        });
    });

    // When the save button is clicked, it syncs the user's skills to Supabase
    btnSaveFind.addEventListener('click', async () => {
        // saves the user's skills to Supabase
        await syncUserSkillsToSupabase();
        // changes the app view to the matches-screen
        switchScreen('matches-screen');
        // Loads the candidate matches
        await renderCandidateMatches();
    });
}

// Renders the skill cloud based on the current state (filters and search query)
function renderSkillCloud() {
    const container = document.getElementById('skill-nodes-container');
    // Retrieves the current user's information
    const user = state.currentUser;

    // sets the count of offered and wanted skills in the UI
    document.getElementById('count-offered').textContent = user.offered.length;
    document.getElementById('count-wanted').textContent = user.wanted.length;

    // Builds a filtered list of skills
    const filteredSkills = state.skills.filter(s => {
        const matchesCat = (state.activeCategory === 'all') || (s.category === state.activeCategory);
        const matchesSearch = s.skill_name.toLowerCase().includes(state.searchQuery);
        return matchesCat && matchesSearch;
    });

    // Handles the case where no skills match the filters or search query
    if (filteredSkills.length === 0) {
        container.innerHTML = `<p style="color: var(--text-muted); text-align: center;">No skills found.</p>`;
        return;
    }

    // Generates the HTML for each skill bubble based on whether the user has selected it as offered or wanted
    container.innerHTML = filteredSkills.map(s => {
        const isOffered = user.offered.includes(s.id);
        const isWanted = user.wanted.includes(s.id);

        // Sets the CSS class for the skill bubble based on its selection state
        let bubbleClass = 'skill-bubble';
        if (isOffered) bubbleClass += ' selected-offered';
        if (isWanted) bubbleClass += ' selected-wanted';

        // Returns the HTML for the skill bubble, including the skill name and icons
        return `
            <div class="${bubbleClass}" onclick="toggleSkillSelection(${s.id})">
                <span>${s.skill_name}</span>
                ${isOffered ? '✓' : ''} ${isWanted ? '★' : ''}
            </div>
        `;
        // Joins all the skill bubble HTML strings into a single string
    }).join('');
}

// Toggles the selection of a skill as offered or wanted based on the current cloud mode
async function toggleSkillSelection(skillId) {
    const user = state.currentUser;
    const mode = state.cloudMode;

    if (mode === 'offered') {
        if (user.offered.includes(skillId)) {
            user.offered = user.offered.filter(id => id !== skillId);
        } else {
            user.offered.push(skillId);
        }
    } else {
        if (user.wanted.includes(skillId)) {
            user.wanted = user.wanted.filter(id => id !== skillId);
        } else {
            user.wanted.push(skillId);
        }
    }

    // Re-render the skill cloud to reflect the current selection state
    renderSkillCloud();
}

// Syncs user skills to Supabase
async function syncUserSkillsToSupabase() {
    if (!supabaseClient || !state.currentUser.id) return;
    const userId = state.currentUser.id;

    try {
        await supabaseClient.from('user_skills_offered').delete().eq('user_id', userId);
        if (state.currentUser.offered.length > 0) {
            const rows = state.currentUser.offered.map(sid => ({ user_id: userId, skill_id: sid }));
            await supabaseClient.from('user_skills_offered').insert(rows);
        }

        await supabaseClient.from('user_skills_wanted').delete().eq('user_id', userId);
        if (state.currentUser.wanted.length > 0) {
            const rows = state.currentUser.wanted.map(sid => ({ user_id: userId, skill_id: sid }));
            await supabaseClient.from('user_skills_wanted').insert(rows);
        }
    } catch (e) {
        console.error('Error syncing skills to Supabase:', e);
    }
}

// Section 6: Peer matchmaking algorithm

// Calculates skill matches between current user and candidates and and and
function computeMatches() {
    const user = state.currentUser;
    const candidates = state.profiles.filter(p => p.id !== user.id && !state.passedCandidates.includes(p.id));
    const results = [];

    // Loop through each candidate to find skill matches
    for (const candidate of candidates) {
        // Mutual Swap check: see if both students have skills the other wants to learn
        const directMatchIds = (candidate.offered || []).filter(s => user.wanted.includes(s));
        const reciprocalMatchIds = (candidate.wanted || []).filter(s => user.offered.includes(s));
        const isMutualSwap = (directMatchIds.length > 0) && (reciprocalMatchIds.length > 0);

        if (directMatchIds.length > 0) {
            const directNames = directMatchIds.map(id => {
                const item = state.skills.find(s => s.id === id);
                return item ? item.skill_name : `Skill #${id}`;
            });
            const reciprocalNames = reciprocalMatchIds.map(id => {
                const item = state.skills.find(s => s.id === id);
                return item ? item.skill_name : `Skill #${id}`;
            });

            results.push({
                candidate,
                directMatchIds,
                reciprocalMatchIds,
                directNames,
                reciprocalNames,
                isMutualSwap,
                isAccepted: state.acceptedCandidates.includes(candidate.id),
                isPassed: state.passedCandidates.includes(candidate.id)
            });
        }
    }

    // Sort Mutual Swaps to top
    return results.sort((a, b) => {
        if (a.isMutualSwap !== b.isMutualSwap) return b.isMutualSwap ? 1 : -1;
        return b.directNames.length - a.directNames.length;
    });
}

async function renderCandidateMatches() {
    await refreshLiveProfilesFromSupabase();

    const container = document.getElementById('candidates-choice-grid');
    const matches = computeMatches();

    document.getElementById('total-matches-count').textContent = matches.length;
    document.getElementById('mutual-matches-count').textContent = matches.filter(m => m.isMutualSwap).length;

    if (matches.length === 0) {
        container.innerHTML = `
            <div class="card" style="grid-column: 1 / -1; text-align: center; color: var(--text-muted); padding: 40px;">
                <h3>No Matching Students Found Yet</h3>
                <p>Select skills you want to learn in Step 1, or ask your classmate to sign up with a different email!</p>
            </div>
        `;
        return;
    }

    container.innerHTML = matches.map(m => {
        const c = m.candidate;
        const initials = (c.full_name || 'ST').split(' ').map(n => n[0]).join('').toUpperCase();
        const isAccepted = m.isAccepted;
        const isPassed = m.isPassed;

        return `
            <div class="candidate-card ${m.isMutualSwap ? 'is-mutual' : ''}" style="${isAccepted ? 'border-color: #10B981; box-shadow: 0 0 15px rgba(16, 185, 129, 0.25);' : ''}">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                    <span class="badge-rank ${m.isMutualSwap ? 'mutual' : 'direct'}">
                        ${m.isMutualSwap ? '⇄ Mutual Swap' : '→ Direct Match'}
                    </span>
                    ${isAccepted ? `<span class="mini-tag" style="background: rgba(16, 185, 129, 0.2); color: #10B981; border: 1px solid #10B981; font-weight: 700;">✓ In My Swaps</span>` : ''}
                </div>

                <div class="candidate-profile-row">
                    <div class="c-avatar">${initials}</div>
                    <div>
                        <div class="c-name">${c.full_name}</div>
                        <div class="c-email">${c.email}</div>
                        <div class="c-degree">${c.degree_course}</div>
                    </div>
                </div>

                <div class="skill-match-box">
                    <div class="box-row-lbl">They Offer What You Want:</div>
                    <div class="tag-list">
                        ${m.directNames.map(s => `<span class="mini-tag offered">${s}</span>`).join('')}
                    </div>

                    ${m.isMutualSwap ? `
                        <div class="box-row-lbl" style="margin-top: 6px;">You Offer What They Want:</div>
                        <div class="tag-list">
                            ${m.reciprocalNames.map(s => `<span class="mini-tag wanted">${s}</span>`).join('')}
                        </div>
                    ` : ''}
                </div>

                <div class="action-buttons-row">
                    ${isAccepted ? `
                        <button class="btn btn-sm" style="flex: 1; background: linear-gradient(135deg, #10B981, #059669); color: white; border: none; font-weight: 700;" onclick="openChatModal('${c.id}')">
                            ✓ Connected • Open Chat 💬
                        </button>
                    ` : isPassed ? `
                        <button class="btn btn-outline btn-sm" style="flex: 1; opacity: 0.7;" onclick="acceptMatch('${c.id}')">
                            ↩️ Undo & Accept Match
                        </button>
                    ` : `
                        <button class="btn btn-success btn-sm" onclick="acceptMatch('${c.id}')">
                            ✓ Accept & Connect
                        </button>
                        <button class="btn btn-danger btn-sm" onclick="passMatch('${c.id}')">
                            ✕ Pass / Skip
                        </button>
                    `}
                </div>
            </div>
        `;
    }).join('');
}

async function acceptMatch(candidateId) {
    if (!state.acceptedCandidates.includes(candidateId)) {
        state.acceptedCandidates.push(candidateId);
    }

    // Save to LocalStorage cache
    try {
        localStorage.setItem(`accepted_${state.currentUser.email}`, JSON.stringify(state.acceptedCandidates));
    } catch (e) {}

    // Save to Supabase DB table `match_decisions`
    if (supabaseClient && state.currentUser.id) {
        await supabaseClient.from('match_decisions').upsert([{
            user_id: state.currentUser.id,
            candidate_id: candidateId,
            status: 'accepted'
        }]);
    }

    document.getElementById('accepted-count-badge').textContent = state.acceptedCandidates.length;
    await renderCandidateMatches();
    renderAcceptedSwaps();
    alert('Match Accepted! You can now chat in "My Swaps".');
}

async function passMatch(candidateId) {
    if (!state.passedCandidates.includes(candidateId)) {
        state.passedCandidates.push(candidateId);
    }

    // Save to LocalStorage cache
    try {
        localStorage.setItem(`passed_${state.currentUser.email}`, JSON.stringify(state.passedCandidates));
    } catch (e) {}

    // Save to Supabase DB table `match_decisions`
    if (supabaseClient && state.currentUser.id) {
        await supabaseClient.from('match_decisions').upsert([{
            user_id: state.currentUser.id,
            candidate_id: candidateId,
            status: 'passed'
        }]);
    }

    await renderCandidateMatches();
}

/**
 * Renders connected accepted swaps under Step 3, with completion toggle support.
 * Active swaps are displayed on top, while completed swaps move down to the bottom.
 */
function renderAcceptedSwaps() {
    const container = document.getElementById('accepted-swaps-list');
    const acceptedProfiles = state.profiles.filter(p => state.acceptedCandidates.includes(p.id));

    if (acceptedProfiles.length === 0) {
        container.innerHTML = `<p style="color: var(--text-muted);">No accepted swaps yet. Accept matches from Step 2 to start chatting!</p>`;
        return;
    }

    if (!state.completedSwaps) state.completedSwaps = [];

    // Sort: Uncompleted active swaps stay on top, completed swaps go to the bottom
    acceptedProfiles.sort((a, b) => {
        const aDone = state.completedSwaps.includes(a.id) ? 1 : 0;
        const bDone = state.completedSwaps.includes(b.id) ? 1 : 0;
        return aDone - bDone;
    });

    container.innerHTML = acceptedProfiles.map(c => {
        const initials = (c.full_name || 'ST').split(' ').map(n => n[0]).join('').toUpperCase();
        const isCompleted = state.completedSwaps.includes(c.id);

        return `
            <div class="candidate-card ${isCompleted ? 'is-completed' : 'is-mutual'}">
                <div class="candidate-profile-row">
                    <div class="c-avatar">${initials}</div>
                    <div>
                        <div class="c-name">${c.full_name}</div>
                        <div class="c-email">${c.email}</div>
                        <div class="c-degree">${c.degree_course}</div>
                    </div>
                </div>
                <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 12px; gap: 8px; flex-wrap: wrap;">
                    <span style="color: ${isCompleted ? '#10b981' : 'var(--status-success)'}; font-weight: 700; font-size: 0.82rem;">
                        ${isCompleted ? '🎓 Skill Swap Completed' : '✅ Connected Swap Active'}
                    </span>
                    <div style="display: flex; gap: 8px;">
                        <button class="btn ${isCompleted ? 'btn-secondary' : 'btn-success'} btn-sm" onclick="toggleSkillLearned('${c.id}')">
                            ${isCompleted ? '✓ Completed' : '🎓 Skill Learned'}
                        </button>
                        <button class="btn btn-primary btn-sm" onclick="openChatModal('${c.id}')">
                            💬 Open Chat
                        </button>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

/**
 * Toggles a swap status to "Skill Learned", moves card to the bottom, and persists to Supabase DB
 */
async function toggleSkillLearned(candidateId) {
    if (!state.completedSwaps) state.completedSwaps = [];

    if (state.completedSwaps.includes(candidateId)) {
        state.completedSwaps = state.completedSwaps.filter(id => id !== candidateId);
    } else {
        state.completedSwaps.push(candidateId);
    }

    // Save to LocalStorage cache
    try {
        localStorage.setItem(`completed_${state.currentUser.email}`, JSON.stringify(state.completedSwaps));
    } catch (e) {}

    // Save status to Supabase `match_decisions` DB table
    if (supabaseClient && state.currentUser.id) {
        const isDone = state.completedSwaps.includes(candidateId);
        await supabaseClient.from('match_decisions').upsert([{
            user_id: state.currentUser.id,
            candidate_id: candidateId,
            status: isDone ? 'completed' : 'accepted'
        }]);
    }

    renderAcceptedSwaps();
}

// Section 7: In-app peer chat

function initChatControls() {
    // Get the chat modal container.
    const chatModal = document.getElementById('chat-modal');
    // Get the chat close button.
    const btnCloseChat = document.getElementById('btn-close-chat');
    // Get the message form.
    const chatForm = document.getElementById('chat-form');

    // Close the modal when its close button is clicked.
    btnCloseChat.addEventListener('click', closeChatModal);

    chatModal.addEventListener('click', (e) => {
        if (e.target === chatModal) closeChatModal();
    });

    chatForm.addEventListener('submit', (e) => {
        // Prevent page navigation after submitting a message.
        e.preventDefault();
        // Get the message input.
        const input = document.getElementById('chat-input');
        // Read and trim the message content.
        const text = input.value.trim();

        if (text && state.activeChatPeerId) {
            // Send to the currently active peer.
            sendChatMessage(state.currentUser.id, state.activeChatPeerId, text);
            // Clear the sent message from the input.
            input.value = '';
        }
    });
}

// Opens chat drawer and starts 3-second refresh timer
function openChatModal(peerId) {
    // Store the active conversation peer.
    state.activeChatPeerId = peerId;
    // Find the selected peer profile.
    const peer = state.profiles.find(p => p.id === peerId);
    // Stop when the peer is unavailable.
    if (!peer) return;

    const initials = (peer.full_name || 'ST').split(' ').map(n => n[0]).join('').toUpperCase();
    // Show the peer initials in the avatar.
    document.getElementById('chat-peer-avatar').textContent = initials;
    // Show the peer name.
    document.getElementById('chat-peer-name').textContent = peer.full_name;
    document.getElementById('chat-peer-status').textContent = `Matched Student • ${peer.degree_course}`;

    // Display the chat modal.
    document.getElementById('chat-modal').classList.remove('hidden');

    // Load the existing conversation.
    loadChatMessages(peerId);

    // Queries Supabase every 3 seconds for new incoming messages
    // Stop a previous polling timer before starting another.
    if (state.chatPollingTimer) clearInterval(state.chatPollingTimer);
    state.chatPollingTimer = setInterval(() => {
        if (state.activeChatPeerId === peerId) {
            // Refresh messages only for the active chat.
            loadChatMessages(peerId);
        }
    }, 3000);
}

function closeChatModal() {
    // Hide the chat modal.
    document.getElementById('chat-modal').classList.add('hidden');
    // Clear the selected peer.
    state.activeChatPeerId = null;
    if (state.chatPollingTimer) {
        // Stop polling for incoming messages.
        clearInterval(state.chatPollingTimer);
        state.chatPollingTimer = null;
    }
}

// Renders message locally first so it displays instantly
async function sendChatMessage(senderId, receiverId, content) {
    // Construct a local message for instant display.
    const newMsg = {
        id: `m_${Date.now()}`,
        sender_id: senderId,
        receiver_id: receiverId,
        content: content,
        created_at: new Date().toISOString()
    };

    // Instant local push
    // Add the message to the local cache.
    state.messages.push(newMsg);
    // Render before the database write completes.
    renderChatUI(getConversationMessages(receiverId), senderId);

    // Async Supabase insert
    if (supabaseClient) {
        try {
            await supabaseClient
                .from('messages')
                .insert([{ sender_id: senderId, receiver_id: receiverId, content }]);
        } catch (err) {
            console.error('Supabase Chat Error:', err);
        }
    }
}

// Fetches conversation messages from Supabase
async function loadChatMessages(peerId) {
    // Capture the logged-in student's ID.
    const currentUserId = state.currentUser.id;

    if (supabaseClient) {
        try {
            const { data, error } = await supabaseClient
                .from('messages')
                .select('*')
                .or(`and(sender_id.eq.${currentUserId},receiver_id.eq.${peerId}),and(sender_id.eq.${peerId},receiver_id.eq.${currentUserId})`)
                .order('created_at', { ascending: true });

            // Merge returned messages only after a successful query.
            if (!error && data && data.length > 0) {
                for (const dbMsg of data) {
                    if (!state.messages.some(m => m.id === dbMsg.id || (m.content === dbMsg.content && m.sender_id === dbMsg.sender_id))) {
                        // Cache messages not already shown locally.
                        state.messages.push(dbMsg);
                    }
                }
            }
        } catch (e) {
            // Fall back
        }
    }

    // Render the refreshed conversation.
    renderChatUI(getConversationMessages(peerId), currentUserId);
}

// Sorts chat messages by timestamp
function getConversationMessages(peerId) {
    // Identify the current student for filtering.
    const currentUserId = state.currentUser.id;
    // Return this peer's messages sorted chronologically.
    return state.messages.filter(m => 
        (m.sender_id === currentUserId && m.receiver_id === peerId) ||
        (m.sender_id === peerId && m.receiver_id === currentUserId)
    ).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

function renderChatUI(messages, currentUserId) {
    // Get the chat-bubble container.
    const box = document.getElementById('chat-messages-box');

    if (!messages || messages.length === 0) {
        // Show guidance when the conversation is empty.
        box.innerHTML = `<div style="text-align: center; color: var(--text-muted); margin-top: 40px;">Say hi to coordinate your skill swap session!</div>`;
        return;
    }

    box.innerHTML = messages.map(m => {
        // Choose the bubble style based on who sent the message.
        const isSent = (m.sender_id === currentUserId);
        // Format the timestamp for the chat bubble.
        const timeStr = new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        return `
            <div class="chat-bubble ${isSent ? 'sent' : 'received'}">
                <span class="chat-text">${m.content}</span>
                <span class="chat-time">${timeStr}</span>
            </div>
        `;
    }).join('');

    // Scroll so the most recent message stays visible.
    box.scrollTop = box.scrollHeight;
}

// Section 8: Offline seeds

function getDefaultSkillsSeed() {
    return [
        { id: 1, skill_name: 'Poetry & Spoken Word', category: 'Arts & Poetry' },
        { id: 2, skill_name: 'Arabic Literature', category: 'Languages' },
        { id: 3, skill_name: 'French Speaking', category: 'Languages' },
        { id: 4, skill_name: 'Spanish Conversation', category: 'Languages' },
        { id: 5, skill_name: 'German Language', category: 'Languages' },
        { id: 6, skill_name: 'English Creative Writing', category: 'Arts & Poetry' },
        { id: 7, skill_name: 'Calligraphy & Painting', category: 'Arts & Poetry' },
        { id: 8, skill_name: 'Digital Illustration', category: 'Arts & Poetry' },
        { id: 9, skill_name: 'Acoustic Guitar', category: 'Arts & Poetry' },
        { id: 10, skill_name: 'Piano & Music Theory', category: 'Arts & Poetry' },
        { id: 11, skill_name: 'Vocal Training', category: 'Arts & Poetry' },
        { id: 12, skill_name: 'Photography & Lighting', category: 'Arts & Poetry' },
        { id: 13, skill_name: 'Filmmaking & Video Editing', category: 'Arts & Poetry' },
        { id: 14, skill_name: 'Sculpture & Pottery', category: 'Arts & Poetry' },
        { id: 15, skill_name: 'Acting & Drama', category: 'Arts & Poetry' },
        { id: 16, skill_name: 'Python Programming', category: 'Technology' },
        { id: 17, skill_name: 'JavaScript & Web Dev', category: 'Technology' },
        { id: 18, skill_name: 'Data Science & AI', category: 'Technology' },
        { id: 19, skill_name: 'PostgreSQL & Databases', category: 'Technology' },
        { id: 20, skill_name: 'Cybersecurity Fundamentals', category: 'Technology' },
        { id: 21, skill_name: 'UI/UX Design', category: 'Technology' },
        { id: 22, skill_name: 'Mobile App Dev', category: 'Technology' },
        { id: 23, skill_name: 'Discrete Mathematics', category: 'Sciences' },
        { id: 24, skill_name: 'Calculus & Algebra', category: 'Sciences' },
        { id: 25, skill_name: 'Statistics & Probability', category: 'Sciences' },
        { id: 26, skill_name: 'Physics & Mechanics', category: 'Sciences' },
        { id: 27, skill_name: 'Organic Chemistry', category: 'Sciences' },
        { id: 28, skill_name: 'Biology & Genetics', category: 'Sciences' },
        { id: 29, skill_name: 'Public Speaking & Debating', category: 'Humanities' },
        { id: 30, skill_name: 'Philosophy & Ethics', category: 'Humanities' },
        { id: 31, skill_name: 'World History', category: 'Humanities' },
        { id: 32, skill_name: 'Psychology Basics', category: 'Humanities' },
        { id: 33, skill_name: 'Macroeconomics', category: 'Humanities' },
        { id: 34, skill_name: 'Financial Planning', category: 'Humanities' },
        { id: 35, skill_name: 'Marketing & Social Media', category: 'Humanities' },
        { id: 36, skill_name: 'Project Management', category: 'Humanities' },
        { id: 37, skill_name: 'Academic Research', category: 'Humanities' },
        { id: 38, skill_name: 'Japanese Language', category: 'Languages' },
        { id: 39, skill_name: 'Italian Language', category: 'Languages' },
        { id: 40, skill_name: 'Mandarin Basics', category: 'Languages' },
        { id: 41, skill_name: 'Chess Strategy', category: 'Arts & Poetry' },
        { id: 42, skill_name: '3D Animation & Blender', category: 'Arts & Poetry' },
        { id: 43, skill_name: 'Songwriting', category: 'Arts & Poetry' },
        { id: 44, skill_name: 'Graphic Design & Canva', category: 'Arts & Poetry' },
        { id: 45, skill_name: 'Game Development (Unity)', category: 'Technology' },
        { id: 46, skill_name: 'Machine Learning Basics', category: 'Technology' },
        { id: 47, skill_name: 'Speed Reading', category: 'Humanities' },
        { id: 48, skill_name: 'Critical Thinking', category: 'Humanities' },
        { id: 49, skill_name: 'Sound Engineering', category: 'Arts & Poetry' },
        { id: 50, skill_name: 'Fashion & Costume Design', category: 'Arts & Poetry' }
    ];
}

function getDefaultProfilesSeed() {
    return [
        {
            id: '10000000-0000-0000-0000-000000000001',
            full_name: 'Ahmed Samir',
            email: 'ahmeds01@eue.edu.eg',
            degree_course: 'Computer Science',
            offered: [1, 2, 3],
            wanted: [18, 32]
        },
        {
            id: '10000000-0000-0000-0000-000000000002',
            full_name: 'Salma El-Sayed',
            email: 'salmae02@eue.edu.eg',
            degree_course: 'Software Engineering',
            offered: [4, 5, 6],
            wanted: [21, 35]
        },
        {
            id: '10000000-0000-0000-0000-000000000003',
            full_name: 'Omar Farahat',
            email: 'omarfa03@eue.edu.eg',
            degree_course: 'Business Administration',
            offered: [7, 8, 9],
            wanted: [24, 38]
        },
        {
            id: '10000000-0000-0000-0000-000000000004',
            full_name: 'Hania Mansour',
            email: 'haniam04@eue.edu.eg',
            degree_course: 'Economics & Political Science',
            offered: [10, 11, 12],
            wanted: [27, 41]
        },
        {
            id: '10000000-0000-0000-0000-000000000005',
            full_name: 'Karim Nabil',
            email: 'karimn05@eue.edu.eg',
            degree_course: 'Design & Media Arts',
            offered: [13, 14, 15],
            wanted: [30, 44]
        }
    ];
}

// Section 9: Screen navigation

function initNavSteps() {
    // Get every navigation step button.
    const stepBtns = document.querySelectorAll('.step-btn');
    // Attach navigation behavior to each button.
    stepBtns.forEach(btn => {
        // Switch screens when a step button is clicked.
        btn.addEventListener('click', () => {
            // Read the screen ID stored on the clicked button.
            const targetScreen = btn.getAttribute('data-screen');
            // Activate the requested screen.
            switchScreen(targetScreen);
        });
    });
}

async function switchScreen(screenId) {
    // Mark every screen as inactive.
    document.querySelectorAll('.screen-view').forEach(s => s.classList.remove('active'));
    // Mark every navigation button as inactive.
    document.querySelectorAll('.step-btn').forEach(b => b.classList.remove('active'));

    // Show the requested screen.
    document.getElementById(screenId).classList.add('active');

    // Locate the button associated with the requested screen.
    const activeBtn = document.querySelector(`.step-btn[data-screen="${screenId}"]`);
    // Highlight the matching navigation button when it exists.
    if (activeBtn) activeBtn.classList.add('active');

    if (screenId === 'matches-screen') {
        // Load and render candidate matches for the matches screen.
        await renderCandidateMatches();
    } else if (screenId === 'accepted-screen') {
        // Render saved accepted swaps for the accepted screen.
        renderAcceptedSwaps();
    }
}

//http post request: When a student submits feedback in our bug reporting modal, our system triggers an asynchronous HTTP email relay that delivers the report straight
//  to our developer's Gmail account (theblankguy313@gmail.com) in real time!
function initBugReportingModal() {
    // Get the button that opens bug reporting.
    const btnReport = document.getElementById('btn-report-bug');
    // Get the bug-report modal.
    const bugModal = document.getElementById('bug-modal');
    // Get the modal close button.
    const btnClose = document.getElementById('btn-close-bug');
    // Get the modal cancel button.
    const btnCancel = document.getElementById('btn-cancel-bug');
    // Get the report submission button.
    const btnSubmit = document.getElementById('btn-submit-bug');
    // Get the report text input.
    const textInput = document.getElementById('bug-text-input');
    // Get the successful-submission message.
    const successMsg = document.getElementById('bug-success-msg');

    // Do nothing if the required reporting UI is absent.
    if (!btnReport || !bugModal) return;

    // Open and reset the bug-report modal.
    btnReport.addEventListener('click', () => {
        // Display the modal.
        bugModal.classList.remove('hidden');
        // Hide a previous success message.
        if (successMsg) successMsg.classList.add('hidden');
        // Clear text from a previous report.
        if (textInput) textInput.value = '';
    });

    // Create one reusable modal-closing function.
    const closeModal = () => bugModal.classList.add('hidden');

    if (btnClose) btnClose.addEventListener('click', closeModal);
    if (btnCancel) btnCancel.addEventListener('click', closeModal);

    bugModal.addEventListener('click', (e) => {
        // Close only when the modal backdrop itself is clicked.
        if (e.target === bugModal) closeModal();
    });

    if (btnSubmit) {
        // Send the report when the student clicks the submit button.
        btnSubmit.addEventListener('click', async () => {
            // Read the entered report text safely.
            const reportContent = textInput ? textInput.value.trim() : '';
            // Use the current student's name or a fallback label.
            const studentName = state.currentUser.full_name || 'Campus Student';
            // Use the current student's email or a fallback address.
            const studentEmail = state.currentUser.email || 'student@eue.edu.eg';

            // Prevent duplicate report submissions while sending.
            // FormSubmit is an email service API that takes data submitted in our web app and sends it straight to our developer team's inbox.
            // We use an HTTP POST request because POST is used for sending new data (like a student's bug report and contact info) to a server.
            // Using JavaScript fetch(), it sends the POST request silently in the background, so the student gets an instant green confirmation message without refreshing or leaving the page!
            try {
                // Dispatch real live email notification to theblankguy313@gmail.com
                await fetch('https://formsubmit.co/ajax/theblankguy313@gmail.com', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    },
                    body: JSON.stringify({
                        _subject: `🐛 Campus SkillSwap Bug Report from ${studentName}`,
                        Student_Name: studentName,
                        Campus_Email: studentEmail,
                        Report_Message: reportContent || 'Campus Bug Report Test',
                        Timestamp: new Date().toLocaleString()
                    })
                });
            } catch (err) {
                // Log a non-blocking notice if email dispatch fails.
                console.warn('Email dispatch notice:', err);
            }

            // Restore the button after the send attempt.
            btnSubmit.disabled = false;
            btnSubmit.textContent = 'Report Sent ✅';

            // Reveal the success message when it exists.
            if (successMsg) successMsg.classList.remove('hidden');
        });
    }
}
