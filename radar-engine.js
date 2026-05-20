(function () {
  const STORAGE_KEY = 'sid-employer-radar-state-v1';
  const DAY_MS = 24 * 60 * 60 * 1000;

  function todayIso() {
    return new Date().toISOString();
  }

  function stableId(prefix, value) {
    let hash = 0;
    const text = String(value);
    for (let i = 0; i < text.length; i += 1) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    return `${prefix}_${Math.abs(hash).toString(36)}`;
  }

  function cleanText(value) {
    return String(value || '').toLowerCase();
  }

  function normalizeName(name) {
    return cleanText(name)
      .replace(/\bpty\b|\bltd\b|\blimited\b|\baustralia\b|\bgroup\b|\bholdings\b/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function matchTerms(text, terms) {
    const haystack = cleanText(text);
    return (terms || []).filter((term) => haystack.includes(cleanText(term)));
  }

  function textIncludesAny(text, terms) {
    return matchTerms(text, terms).length > 0;
  }

  function getJobText(job) {
    return [job.title, job.description_text, job.raw_snippet, job.location_text, job.salary_text].filter(Boolean).join(' ');
  }

  function findOccupation(job, rules) {
    const text = getJobText(job);
    const title = cleanText(job.title);
    let best = null;

    for (const occupation of rules.occupations) {
      const terms = [occupation.title, ...(occupation.common_titles || []), ...(occupation.chinese_titles || [])];
      const matched = matchTerms(`${job.title || ''} ${job.description_text || ''}`, terms);
      if (!matched.length) continue;

      const titleHit = terms.some((term) => title.includes(cleanText(term)));
      const score = titleHit ? 90 : 74;
      const specificity = matched.join(' ').length;
      if (!best || score > best.score || (score === best.score && specificity > best.specificity)) {
        best = { score, specificity, occupation, evidence: matched.slice(0, 4) };
      }
    }

    if (!best && textIncludesAny(text, rules.industryHints || [])) {
      return { score: 42, occupation: null, evidence: matchTerms(text, rules.industryHints).slice(0, 3) };
    }

    return best || { score: 10, occupation: null, evidence: [] };
  }

  function scoreLanguage(job, employer, rules) {
    const text = `${getJobText(job)} ${employer.website || ''} ${(employer.trading_names || []).join(' ')}`;
    const strong = matchTerms(text, rules.language.strong);
    if (strong.length) return { score: 92, evidence: strong.slice(0, 4), tier: 'strong' };

    const medium = matchTerms(text, rules.language.medium);
    if (medium.length) return { score: 62, evidence: medium.slice(0, 4), tier: 'medium' };

    const weak = matchTerms(text, rules.language.weak);
    if (weak.length) return { score: 34, evidence: weak.slice(0, 4), tier: 'weak' };

    return { score: 0, evidence: [], tier: 'none' };
  }

  function scoreSponsorship(job, employer, rules) {
    const text = getJobText(job);
    const negative = matchTerms(text, rules.sponsorship.negative);
    const positive = matchTerms(text, rules.sponsorship.positive);
    const seedSponsor = employer.sponsor_seed === true || employer.sponsor_status === 'matched';

    if (negative.length) {
      return { score: 0, level: 'S-1', negative: true, evidence: negative.slice(0, 4) };
    }

    if (seedSponsor && positive.length) {
      return { score: 96, level: 'S4', negative: false, evidence: ['sponsor seed matched', ...positive].slice(0, 5) };
    }

    if (seedSponsor) {
      return { score: 78, level: 'S3', negative: false, evidence: ['sponsor seed matched'] };
    }

    if (positive.length) {
      return { score: 70, level: 'S2', negative: false, evidence: positive.slice(0, 4) };
    }

    return { score: 18, level: 'S1', negative: false, evidence: [] };
  }

  function scoreRegion(location, rules) {
    if (!location) return { score: 20, tier: 'Unknown', evidence: [] };

    const postcode = Number(location.postcode);
    const suburb = cleanText(location.suburb);
    const lga = cleanText(location.lga);
    const hot = rules.regions.hot_areas.find((area) => (
      cleanText(area.suburb) === suburb || cleanText(area.lga) === lga || Number(area.postcode) === postcode
    ));

    if (hot) {
      return {
        score: 18,
        tier: 'P4',
        evidence: [`hot area: ${hot.reason}`],
        hotArea: true,
        hotPenalty: Number(hot.priority_penalty || 25)
      };
    }

    const tiers = rules.regions.priority_tiers;
    if ((tiers.P1 || []).some((item) => cleanText(item) === suburb || cleanText(item) === lga || Number(item) === postcode)) {
      return { score: 96, tier: 'P1', evidence: ['priority regional match'], hotArea: false, hotPenalty: 0 };
    }
    if ((tiers.P2 || []).some((item) => cleanText(item) === suburb || cleanText(item) === lga || Number(item) === postcode)) {
      return { score: 82, tier: 'P2', evidence: ['regional city match'], hotArea: false, hotPenalty: 0 };
    }
    if ((tiers.P3 || []).some((item) => cleanText(item) === suburb || cleanText(item) === lga || Number(item) === postcode)) {
      return { score: 56, tier: 'P3', evidence: ['fringe match'], hotArea: false, hotPenalty: 0 };
    }
    if (location.regional_category && cleanText(location.regional_category).includes('regional')) {
      return { score: 72, tier: 'Regional', evidence: [location.regional_category], hotArea: false, hotPenalty: 0 };
    }
    return { score: 36, tier: 'Unranked', evidence: [], hotArea: false, hotPenalty: 0 };
  }

  function scoreContact(employer, contacts) {
    const employerContacts = contacts.filter((contact) => contact.employer_id === employer.employer_id && !contact.do_not_contact);
    if (!employerContacts.length) return { score: 0, evidence: [] };

    const ordered = employerContacts.sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0));
    const best = ordered[0];
    const typeScore = {
      careers_email: 96,
      apply_url: 92,
      contact_form: 84,
      generic_email: 72,
      phone: 64,
      website: 48
    };

    return {
      score: Math.max(typeScore[best.contact_type] || 35, Number(best.confidence || 0)),
      evidence: ordered.slice(0, 3).map((contact) => `${contact.contact_type}: ${contact.value}`)
    };
  }

  function scoreFreshness(job, now = new Date()) {
    if (!job.seen_date && !job.posted_date) return 20;
    const date = new Date(job.posted_date || job.seen_date);
    if (Number.isNaN(date.getTime())) return 20;
    const age = Math.max(0, Math.floor((now.getTime() - date.getTime()) / DAY_MS));
    if (age <= 3) return 100;
    if (age <= 7) return 86;
    if (age <= 14) return 72;
    if (age <= 30) return 54;
    return 28;
  }

  function bucketForScore(score, sponsorshipLevel, negative) {
    if (negative) return 'D';
    if (score >= 88 && ['S4', 'S3', 'S2'].includes(sponsorshipLevel)) return 'A';
    if (score >= 72) return 'B';
    if (score >= 55) return 'C';
    return 'D';
  }

  function scoreLead(job, employer, location, contacts, rules, now = new Date()) {
    const language = scoreLanguage(job, employer, rules);
    const sponsorship = scoreSponsorship(job, employer, rules);
    const occupation = findOccupation(job, rules);
    const region = scoreRegion(location, rules);
    const contact = scoreContact(employer, contacts);
    const freshness = scoreFreshness(job, now);

    let finalScore = (
      0.30 * sponsorship.score +
      0.20 * language.score +
      0.20 * occupation.score +
      0.15 * region.score +
      0.10 * contact.score +
      0.05 * freshness
    );

    if (region.hotPenalty) finalScore -= region.hotPenalty;
    if (sponsorship.negative) finalScore -= 40;
    finalScore = Math.max(0, Math.min(100, Math.round(finalScore)));

    return {
      lead_id: `lead_${job.job_id}`,
      employer_id: employer.employer_id,
      latest_job_id: job.job_id,
      region_score: Math.round(region.score),
      language_score: Math.round(language.score),
      sponsorship_score: Math.round(sponsorship.score),
      occupation_score: Math.round(occupation.score),
      contact_score: Math.round(contact.score),
      freshness_score: Math.round(freshness),
      final_score: finalScore,
      priority_bucket: bucketForScore(finalScore, sponsorship.level, sponsorship.negative),
      sponsorship_level: sponsorship.level,
      negative_sponsorship_flag: sponsorship.negative,
      priority_region_tier: region.tier,
      is_hot_area: Boolean(region.hotArea),
      occupation_match: occupation.occupation ? {
        anzsco_code: occupation.occupation.anzsco_code,
        title: occupation.occupation.title,
        csol_flag: occupation.occupation.csol_flag
      } : null,
      evidence: {
        language: language.evidence,
        sponsorship: sponsorship.evidence,
        occupation: occupation.evidence,
        region: region.evidence,
        contact: contact.evidence
      },
      review_status: 'new',
      next_action: sponsorship.negative ? 'discard' : finalScore >= 72 ? 'contact' : 'manual_review',
      scored_at: now.toISOString()
    };
  }

  function scoreState(state, now = new Date()) {
    const contacts = state.contacts || [];
    const locations = state.employer_locations || [];
    const employers = state.employers || [];
    const leadsById = new Map((state.lead_scores || []).map((lead) => [lead.lead_id, lead]));

    const leadScores = (state.job_ads || []).map((job) => {
      const employer = employers.find((item) => item.employer_id === job.employer_id);
      if (!employer) return null;
      const location = locations.find((item) => item.employer_id === employer.employer_id);
      const next = scoreLead(job, employer, location, contacts, state.rules, now);
      const existing = leadsById.get(next.lead_id);
      return {
        ...next,
        review_status: existing?.review_status || next.review_status,
        reviewer_notes: existing?.reviewer_notes || '',
        next_action: existing?.next_action || next.next_action,
        last_contacted: existing?.last_contacted || null
      };
    }).filter(Boolean);

    return {
      ...state,
      lead_scores: leadScores.sort((a, b) => b.final_score - a.final_score),
      meta: { ...state.meta, last_scored_at: now.toISOString() }
    };
  }

  function createInitialState() {
    const now = todayIso();
    const state = {
      meta: {
        app_name: '482/SID Employer Radar',
        version: '0.1.0-pages',
        created_at: now,
        updated_at: now,
        last_scored_at: null,
        last_daily_run_at: null
      },
      rules: {
        language: {
          strong: ['Mandarin required', 'Cantonese required', 'Chinese speaking', 'Chinese speaker', 'Fluent in Mandarin', 'Bilingual English and Chinese', '普通话', '粤语', '中文', '会中文'],
          medium: ['Chinese clients', 'Chinese community', 'bilingual Chinese', 'Mandarin preferred', 'Cantonese preferred'],
          weak: ['Chinese restaurant', 'Asian grocery', 'Chinese school', 'migration service', 'Chinese accounting']
        },
        sponsorship: {
          positive: ['482', 'subclass 482', 'Skills in Demand', 'SID visa', 'TSS', 'Temporary Skill Shortage', 'visa sponsorship', 'sponsorship available', 'employer sponsored', 'nomination', 'approved sponsor', 'labour agreement', 'DAMA', 'relocation support'],
          negative: ['no sponsorship', 'sponsorship is not available', 'must have full working rights', 'Australian citizen or permanent resident only', 'PR or citizen only', 'unrestricted work rights']
        },
        occupations: [
          { anzsco_code: '351311', title: 'Chef', csol_flag: true, common_titles: ['chef', 'sous chef', 'head chef'], chinese_titles: ['厨师'] },
          { anzsco_code: '351411', title: 'Cook', csol_flag: true, common_titles: ['cook', 'line cook'], chinese_titles: ['帮厨'] },
          { anzsco_code: '321212', title: 'Diesel Motor Mechanic', csol_flag: true, common_titles: ['diesel mechanic', 'diesel motor mechanic'], chinese_titles: ['柴油技工'] },
          { anzsco_code: '321211', title: 'Motor Mechanic', csol_flag: true, common_titles: ['motor mechanic', 'automotive mechanic', 'light vehicle mechanic'], chinese_titles: ['汽车维修'] },
          { anzsco_code: '241111', title: 'Early Childhood Teacher', csol_flag: true, common_titles: ['early childhood teacher', 'ect'], chinese_titles: ['幼教'] },
          { anzsco_code: '134111', title: 'Child Care Centre Manager', csol_flag: true, common_titles: ['childcare centre manager', 'child care centre manager'], chinese_titles: ['托儿中心经理'] },
          { anzsco_code: '423111', title: 'Aged or Disabled Carer', csol_flag: true, common_titles: ['aged care worker', 'aged or disabled carer', 'personal care assistant', 'pca'], chinese_titles: ['养老护理', '护理员'] },
          { anzsco_code: '254499', title: 'Registered Nurse', csol_flag: true, common_titles: ['registered nurse', 'rn', 'aged care nurse'], chinese_titles: ['注册护士'] },
          { anzsco_code: '221111', title: 'Accountant', csol_flag: true, common_titles: ['accountant', 'tax accountant'], chinese_titles: ['会计'] },
          { anzsco_code: '261111', title: 'ICT Business Analyst', csol_flag: true, common_titles: ['ict business analyst', 'business analyst'], chinese_titles: ['业务分析师'] },
          { anzsco_code: '261313', title: 'Software Engineer', csol_flag: true, common_titles: ['software engineer', 'developer', 'full stack engineer'], chinese_titles: ['软件工程师'] },
          { anzsco_code: '225113', title: 'Marketing Specialist', csol_flag: true, common_titles: ['marketing specialist', 'digital marketing specialist'], chinese_titles: ['市场专员'] },
          { anzsco_code: '141111', title: 'Cafe or Restaurant Manager', csol_flag: true, common_titles: ['restaurant manager', 'cafe manager', 'venue manager'], chinese_titles: ['餐厅经理'] }
        ],
        industryHints: ['aged care', 'childcare', 'automotive', 'restaurant', 'accounting', 'ict', 'marketing'],
        regions: {
          priority_tiers: {
            P1: ['Mildura', 'Warrnambool', 'Shepparton', 'Horsham', 'Swan Hill', 'Bairnsdale', 'Sale', 'Traralgon', 'Wodonga'],
            P2: ['Ballarat', 'Geelong', 'Bendigo', 'Wangaratta'],
            P3: ['Yarra Ranges', 'Cardinia', 'Mornington Peninsula']
          },
          hot_areas: [
            { suburb: 'Melbourne', postcode: '3000', lga: 'Melbourne', reason: 'CBD high competition', priority_penalty: 30 },
            { suburb: 'Box Hill', postcode: '3128', lga: 'Whitehorse', reason: 'popular Chinese market', priority_penalty: 25 },
            { suburb: 'Glen Waverley', postcode: '3150', lga: 'Monash', reason: 'popular Chinese market', priority_penalty: 25 },
            { suburb: 'Clayton', postcode: '3168', lga: 'Monash', reason: 'popular Chinese market', priority_penalty: 22 },
            { suburb: 'Springvale', postcode: '3171', lga: 'Greater Dandenong', reason: 'popular Chinese market', priority_penalty: 20 }
          ]
        }
      },
      source_policies: [
        { source_name: 'SEEK', allowed_method: 'approved_api_email_alert_search_index_manual_review', tos_status: 'restricted', can_store_content: false, can_use_for_outreach: false, notes: 'Do not automate scraping or bypass anti-bot controls.' },
        { source_name: 'Adzuna', allowed_method: 'api', tos_status: 'api_allowed_with_key', can_store_content: true, can_use_for_outreach: false, notes: 'Use API key and rate limits.' },
        { source_name: 'ABN Lookup', allowed_method: 'api', tos_status: 'registration_required', can_store_content: true, can_use_for_outreach: false, notes: 'Use authentication GUID.' },
        { source_name: 'ASIC data.gov.au', allowed_method: 'licensed_open_data', tos_status: 'open_data', can_store_content: true, can_use_for_outreach: false, notes: 'Use register data for entity enrichment.' },
        { source_name: 'Company websites', allowed_method: 'limited_website_crawl', tos_status: 'check_per_domain', can_store_content: true, can_use_for_outreach: true, notes: 'Limit to about/contact/careers/jobs and respect robots.' },
        { source_name: 'Google Places', allowed_method: 'api', tos_status: 'api_terms', can_store_content: 'field_dependent', can_use_for_outreach: true, notes: 'Use FieldMask and comply with Maps Platform policies.' }
      ],
      employers: [
        { employer_id: 'emp_golden_care', abn: 'DEMO-ABN-001', acn: '', legal_name: 'Golden Care VIC Pty Ltd', trading_names: ['Golden Care'], normalized_name: 'golden care vic', entity_status: 'Active', gst_status: 'Registered', company_type: 'Australian Proprietary Company', registration_date: '2018-04-11', website: 'https://example.com/golden-care', main_phone: '03 7000 0101', main_email: 'careers@goldencare.example', contact_url: 'https://example.com/golden-care/careers', sponsor_seed: true, sponsor_status: 'matched', source_first_seen: now, source_last_checked: now },
        { employer_id: 'emp_abc_auto', abn: 'DEMO-ABN-002', acn: '', legal_name: 'ABC Auto Regional Pty Ltd', trading_names: ['ABC Auto'], normalized_name: 'abc auto regional', entity_status: 'Active', gst_status: 'Registered', company_type: 'Australian Proprietary Company', registration_date: '2015-09-03', website: 'https://example.com/abc-auto', main_phone: '03 7000 0202', main_email: 'jobs@abcauto.example', contact_url: 'https://example.com/abc-auto/jobs', sponsor_seed: true, sponsor_status: 'matched', source_first_seen: now, source_last_checked: now },
        { employer_id: 'emp_cbd_tech', abn: 'DEMO-ABN-003', acn: '', legal_name: 'CBD Tech Solutions Pty Ltd', trading_names: ['CBD Tech'], normalized_name: 'cbd tech solutions', entity_status: 'Active', gst_status: 'Registered', company_type: 'Australian Proprietary Company', registration_date: '2020-02-18', website: 'https://example.com/cbd-tech', main_phone: '03 7000 0303', main_email: 'people@cbdtech.example', contact_url: 'https://example.com/cbd-tech/careers', sponsor_seed: false, sponsor_status: 'unknown', source_first_seen: now, source_last_checked: now }
      ],
      employer_locations: [
        { location_id: 'loc_golden_care', employer_id: 'emp_golden_care', address_raw: 'Shepparton VIC 3630', suburb: 'Shepparton', postcode: '3630', state: 'VIC', lat: -36.3805, lng: 145.3987, lga: 'Greater Shepparton', rdv_region: 'Hume', regional_category: 'Regional centres and other regional areas' },
        { location_id: 'loc_abc_auto', employer_id: 'emp_abc_auto', address_raw: 'Mildura VIC 3500', suburb: 'Mildura', postcode: '3500', state: 'VIC', lat: -34.208, lng: 142.1246, lga: 'Mildura', rdv_region: 'Loddon Mallee', regional_category: 'Regional centres and other regional areas' },
        { location_id: 'loc_cbd_tech', employer_id: 'emp_cbd_tech', address_raw: 'Melbourne VIC 3000', suburb: 'Melbourne', postcode: '3000', state: 'VIC', lat: -37.8136, lng: 144.9631, lga: 'Melbourne', rdv_region: 'Metro', regional_category: 'Major city' }
      ],
      job_ads: [
        { job_id: 'job_golden_care_pca', source_name: 'Demo alert', source_url: 'https://example.com/golden-care/job/pca', source_type: 'email_alert', employer_id: 'emp_golden_care', title: 'Aged Care Worker', description_text: 'Chinese speaking support worker preferred for aged care clients. Employer sponsored pathway may be considered for the right applicant.', location_text: 'Shepparton VIC', postcode: '3630', salary_text: 'Full-time', posted_date: now, seen_date: now, raw_snippet: 'Chinese speaking preferred. Employer sponsored pathway may be considered.', evidence_hash: stableId('ev', 'golden-care-pca') },
        { job_id: 'job_abc_auto_diesel', source_name: 'Demo API', source_url: 'https://example.com/abc-auto/job/diesel', source_type: 'api', employer_id: 'emp_abc_auto', title: 'Diesel Motor Mechanic', description_text: '482 visa sponsorship available for an experienced diesel mechanic. Mandarin preferred due to customer base.', location_text: 'Mildura VIC', postcode: '3500', salary_text: '$75,000 - $90,000 full-time', posted_date: now, seen_date: now, raw_snippet: '482 visa sponsorship available. Mandarin preferred.', evidence_hash: stableId('ev', 'abc-auto-diesel') },
        { job_id: 'job_cbd_tech_dev', source_name: 'Demo search index', source_url: 'https://example.com/cbd-tech/job/dev', source_type: 'search_index', employer_id: 'emp_cbd_tech', title: 'Software Engineer', description_text: 'Bilingual English and Chinese helpful. Applicants must have full working rights. No sponsorship is available.', location_text: 'Melbourne VIC', postcode: '3000', salary_text: '$110,000 full-time', posted_date: now, seen_date: now, raw_snippet: 'Bilingual English and Chinese helpful. No sponsorship is available.', evidence_hash: stableId('ev', 'cbd-tech-dev') }
      ],
      contacts: [
        { contact_id: 'con_golden_care_email', employer_id: 'emp_golden_care', contact_type: 'careers_email', value: 'careers@goldencare.example', role: 'Careers', source_url: 'https://example.com/golden-care/careers', source_context: 'careers page', confidence: 94, is_generic_contact: true, is_personal_contact: false, do_not_contact: false, last_verified: now },
        { contact_id: 'con_abc_auto_email', employer_id: 'emp_abc_auto', contact_type: 'careers_email', value: 'jobs@abcauto.example', role: 'Jobs', source_url: 'https://example.com/abc-auto/jobs', source_context: 'jobs page', confidence: 92, is_generic_contact: true, is_personal_contact: false, do_not_contact: false, last_verified: now },
        { contact_id: 'con_cbd_tech_form', employer_id: 'emp_cbd_tech', contact_type: 'contact_form', value: 'https://example.com/cbd-tech/contact', role: 'Contact form', source_url: 'https://example.com/cbd-tech/contact', source_context: 'contact page', confidence: 76, is_generic_contact: true, is_personal_contact: false, do_not_contact: false, last_verified: now }
      ],
      lead_scores: [],
      activity: [{ activity_id: stableId('act', now), timestamp: now, type: 'system', message: 'GitHub Pages workspace initialized with demo lead cards.' }]
    };
    return scoreState(state);
  }

  function saveState(state) {
    const next = { ...state, meta: { ...state.meta, updated_at: todayIso() } };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    return next;
  }

  function readState() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        return JSON.parse(raw);
      } catch {
        localStorage.removeItem(STORAGE_KEY);
      }
    }
    return saveState(createInitialState());
  }

  function addActivity(state, type, message) {
    const timestamp = todayIso();
    state.activity = [
      { activity_id: stableId('act', `${timestamp}-${message}`), timestamp, type, message },
      ...(state.activity || [])
    ].slice(0, 80);
  }

  function upsertEmployer(state, row) {
    const rawName = row.raw_company_name || row.company || row.company_name || row.name || row.legal_name || '';
    if (!rawName.trim()) return null;

    const abn = String(row.abn || row.ABN || '').trim();
    const normalized = normalizeName(rawName);
    const key = abn || normalized;
    const employerId = stableId('emp', key);
    const existing = state.employers.find((item) => item.employer_id === employerId || (abn && item.abn === abn));
    const sponsorSeed = row.sponsor_seed === true || String(row.sponsor_seed || '').toLowerCase() === 'true' || String(row.source || '').toLowerCase().includes('482');
    const employer = {
      employer_id: existing?.employer_id || employerId,
      abn: abn || existing?.abn || '',
      acn: row.acn || existing?.acn || '',
      legal_name: rawName.trim(),
      trading_names: existing?.trading_names || [],
      normalized_name: normalized,
      entity_status: existing?.entity_status || 'Unknown',
      gst_status: existing?.gst_status || 'Unknown',
      company_type: existing?.company_type || '',
      registration_date: existing?.registration_date || '',
      website: row.website || existing?.website || '',
      main_phone: row.phone || existing?.main_phone || '',
      main_email: row.email || existing?.main_email || '',
      contact_url: row.contact_url || existing?.contact_url || '',
      sponsor_seed: existing?.sponsor_seed || sponsorSeed,
      sponsor_status: existing?.sponsor_status || (sponsorSeed ? 'matched' : 'unknown'),
      known_occupation: row.occupation || row.known_occupation || existing?.known_occupation || '',
      source_first_seen: existing?.source_first_seen || todayIso(),
      source_last_checked: todayIso()
    };

    if (existing) Object.assign(existing, employer);
    else state.employers.push(employer);

    const postcode = row.postcode || row.Postcode || '';
    const suburb = row.suburb || row.Suburb || '';
    if (postcode || suburb) {
      const existingLocation = state.employer_locations.find((item) => item.employer_id === employer.employer_id);
      const location = {
        location_id: existingLocation?.location_id || stableId('loc', `${employer.employer_id}-${postcode}-${suburb}`),
        employer_id: employer.employer_id,
        address_raw: row.address || [suburb, row.state || 'VIC', postcode].filter(Boolean).join(' '),
        suburb,
        postcode,
        state: row.state || 'VIC',
        lat: Number(row.lat || existingLocation?.lat || 0),
        lng: Number(row.lng || existingLocation?.lng || 0),
        lga: row.lga || existingLocation?.lga || '',
        rdv_region: row.rdv_region || existingLocation?.rdv_region || '',
        regional_category: row.regional_category || existingLocation?.regional_category || ''
      };
      if (existingLocation) Object.assign(existingLocation, location);
      else state.employer_locations.push(location);
    }

    if (row.email || row.phone || row.contact_url || row.website) {
      const contactValue = row.email || row.contact_url || row.phone || row.website;
      const contactType = row.email ? 'generic_email' : row.contact_url ? 'contact_form' : row.phone ? 'phone' : 'website';
      const contactId = stableId('con', `${employer.employer_id}-${contactType}-${contactValue}`);
      if (!state.contacts.some((item) => item.contact_id === contactId)) {
        state.contacts.push({
          contact_id: contactId,
          employer_id: employer.employer_id,
          contact_type: contactType,
          value: contactValue,
          role: contactType,
          source_url: row.website || row.contact_url || '',
          source_context: 'seed import',
          confidence: contactType === 'generic_email' ? 72 : 58,
          is_generic_contact: true,
          is_personal_contact: false,
          do_not_contact: false,
          last_verified: todayIso()
        });
      }
    }

    return employer;
  }

  function discoverSeedJobs(state) {
    let created = 0;
    for (const employer of state.employers) {
      if (!employer.known_occupation) continue;
      const exists = state.job_ads.some((job) => job.employer_id === employer.employer_id);
      if (exists) continue;
      const location = state.employer_locations.find((item) => item.employer_id === employer.employer_id);
      const jobId = stableId('job', `${employer.employer_id}-${employer.known_occupation}`);
      state.job_ads.push({
        job_id: jobId,
        source_name: 'Manual seed',
        source_url: employer.contact_url || employer.website || '',
        source_type: 'manual_review',
        employer_id: employer.employer_id,
        title: employer.known_occupation,
        description_text: `${employer.known_occupation} candidate target from seed list. Manual review required before outreach.`,
        location_text: location ? [location.suburb, location.state].filter(Boolean).join(' ') : '',
        postcode: location?.postcode || '',
        salary_text: '',
        posted_date: todayIso(),
        seen_date: todayIso(),
        raw_snippet: 'Seed occupation target. Needs current vacancy evidence.',
        evidence_hash: stableId('ev', jobId)
      });
      created += 1;
    }
    return created;
  }

  function enrichCompanies(state) {
    let changed = 0;
    for (const employer of state.employers) {
      employer.source_last_checked = todayIso();
      if (!employer.contact_url && employer.website) {
        employer.contact_url = `${employer.website.replace(/\/$/, '')}/careers`;
        changed += 1;
      }
    }
    return changed;
  }

  async function runAction(action, payload = {}) {
    let state = readState();
    let message = '';

    if (action === 'daily-run') {
      const discovered = discoverSeedJobs(state);
      const enriched = enrichCompanies(state);
      state = scoreState(state);
      state.meta.last_daily_run_at = todayIso();
      message = `Daily radar completed: ${discovered} seed jobs created, ${enriched} companies enriched, ${state.lead_scores.length} leads scored.`;
      addActivity(state, 'daily_run', message);
    } else if (action === 'sync-seeds') {
      for (const employer of state.employers) {
        employer.normalized_name = normalizeName(employer.legal_name);
        employer.source_last_checked = todayIso();
      }
      message = `Sponsor seeds normalized: ${state.employers.length} employers checked.`;
      addActivity(state, 'sync', message);
    } else if (action === 'discover-jobs') {
      const discovered = discoverSeedJobs(state);
      message = `Job discovery finished: ${discovered} seed-based review jobs created.`;
      addActivity(state, 'job_discovery', message);
    } else if (action === 'enrich-companies') {
      const enriched = enrichCompanies(state);
      message = `Company enrichment finished: ${enriched} contact URLs filled.`;
      addActivity(state, 'enrichment', message);
    } else if (action === 'score-leads') {
      state = scoreState(state);
      message = `Lead scoring refreshed: ${state.lead_scores.length} leads ranked.`;
      addActivity(state, 'scoring', message);
    } else if (action === 'import-seeds') {
      const rows = Array.isArray(payload.rows) ? payload.rows : [];
      let imported = 0;
      for (const row of rows) {
        if (upsertEmployer(state, row)) imported += 1;
      }
      state = scoreState(state);
      message = `Seed import finished: ${imported} employers upserted.`;
      addActivity(state, 'import', message);
    } else if (action === 'review-lead') {
      const lead = state.lead_scores.find((item) => item.lead_id === payload.lead_id);
      if (!lead) throw new Error('Lead not found');
      lead.review_status = payload.review_status || lead.review_status;
      lead.next_action = payload.next_action || lead.next_action;
      lead.reviewer_notes = payload.reviewer_notes ?? lead.reviewer_notes;
      if (payload.review_status === 'contacted') lead.last_contacted = todayIso();
      message = `Lead ${lead.lead_id} marked ${lead.review_status}.`;
      addActivity(state, 'review', message);
    } else if (action === 'reset-demo') {
      state = createInitialState();
      message = 'Demo workspace reset.';
      addActivity(state, 'system', message);
    } else {
      throw new Error(`Unknown action: ${action}`);
    }

    state = saveState(state);
    return { state, message };
  }

  function escapeCell(value) {
    const text = value == null ? '' : String(value);
    if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
    return text;
  }

  function exportLeadsCsv(state) {
    const headers = [
      ['priority_bucket', (row) => row.lead.priority_bucket],
      ['final_score', (row) => row.lead.final_score],
      ['company', (row) => row.employer.legal_name],
      ['abn', (row) => row.employer.abn],
      ['suburb', (row) => row.location.suburb],
      ['postcode', (row) => row.location.postcode],
      ['job_title', (row) => row.job.title],
      ['sponsorship_level', (row) => row.lead.sponsorship_level],
      ['language_evidence', (row) => (row.lead.evidence.language || []).join(' | ')],
      ['sponsorship_evidence', (row) => (row.lead.evidence.sponsorship || []).join(' | ')],
      ['occupation', (row) => row.lead.occupation_match?.title || ''],
      ['contact_type', (row) => row.bestContact.contact_type],
      ['contact', (row) => row.bestContact.value],
      ['source_url', (row) => row.job.source_url],
      ['review_status', (row) => row.lead.review_status],
      ['next_action', (row) => row.lead.next_action]
    ];

    const rows = state.lead_scores.map((lead) => {
      const employer = state.employers.find((item) => item.employer_id === lead.employer_id) || {};
      const job = state.job_ads.find((item) => item.job_id === lead.latest_job_id) || {};
      const location = state.employer_locations.find((item) => item.employer_id === lead.employer_id) || {};
      const bestContact = state.contacts
        .filter((item) => item.employer_id === lead.employer_id && !item.do_not_contact)
        .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))[0] || {};
      return { lead, employer, job, location, bestContact };
    });

    const output = [headers.map(([label]) => escapeCell(label)).join(',')];
    for (const row of rows) {
      output.push(headers.map(([, value]) => escapeCell(value(row))).join(','));
    }
    return `${output.join('\n')}\n`;
  }

  window.RadarEngine = {
    readState,
    runAction,
    exportLeadsCsv,
    saveState,
    createInitialState
  };
}());
