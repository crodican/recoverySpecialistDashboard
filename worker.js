// worker.js

// Define table IDs for easy access
const CERTIFICATIONS_TABLE_ID = "@u5qvrik517o";

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // Handle API routes
        if (url.pathname.startsWith('/api/')) {
            return handleApiRequest(request, url, env);
        }

        // Serve static assets from the /public directory configured in wrangler.toml [site]
        // Cloudflare's Workers deployment with `[site]` binding automatically serves
        // files from the specified `bucket` (your `public` folder) at the root path.
        // We just need to ensure /index.html is returned for SPA routing.
        try {
            // Attempt to serve the static file directly
            // Cloudflare's internal static asset handler will process this request
            const response = await fetch(request);

            // If it's a 404 (file not found), and it's not an API route,
            // assume it's a client-side route and serve index.html
            if (response.status === 404 && !url.pathname.startsWith('/api/')) {
                // Fetch index.html to serve for client-side routing
                // The `url.origin` ensures we construct a correct URL for the static asset handler
                const indexResponse = await fetch(`${url.origin}/index.html`);
                if (indexResponse.ok) {
                    return new Response(indexResponse.body, {
                        headers: { 'Content-Type': 'text/html' },
                        status: 200 // Always 200 for SPA fallback
                    });
                }
            }
            return response; // Serve the requested static file if found
        } catch (e) {
            // Log error, and fallback to index.html if possible
            console.error("Error serving static asset:", e);
            const indexResponse = await fetch(`${url.origin}/index.html`);
            if (indexResponse.ok) {
                return new Response(indexResponse.body, {
                    headers: { 'Content-Type': 'text/html' },
                    status: 200
                });
            }
            return new Response('Error serving static content', { status: 500 });
        }
    },
};

// --- API Request Handler ---
async function handleApiRequest(request, url, env) {
    const headers = {
        'Content-Type': 'application/json',
        // Enable CORS for your frontend. Adjust origin as needed in production.
        'Access-Control-Allow-Origin': '*', // Or your Cloudflare Worker URL, e.g., 'https://your-worker-name.youraccount.workers.dev'
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, x-token', // Ensure your custom token header is allowed
    };

    // Handle preflight OPTIONS requests for CORS
    if (request.method === 'OPTIONS') {
        return new Response(null, { headers });
    }

    try {
        switch (url.pathname) {
            case '/api/certifications':
                return fetchAllCertifications(request, env, headers);
            case '/api/summary':
                return getCertificationsSummary(request, env, headers);
            case '/api/monthly-trends':
                return getMonthlyTrends(request, env, headers);
            case '/api/table-data':
                return getTableData(request, env, headers); // For DataTables server-side processing
            default:
                return new Response(JSON.stringify({ error: 'API endpoint not found' }), { status: 404, headers });
        }
    } catch (error) {
        console.error("API Error:", error);
        return new Response(JSON.stringify({ error: 'Internal Server Error', details: error.message }), { status: 500, headers });
    }
}

// --- NocoDB Data Fetching Helper ---
async function fetchFromNocoDB(env, tableId, queryParams = {}) {
    let queryString = new URLSearchParams(queryParams).toString();
    if (queryString) {
        queryString = '?' + queryString;
    }
    const nocodbUrl = `${env.NOCODB_BASE_URL}${tableId}/records${queryString}`;

    const response = await fetch(nocodbUrl, {
        headers: { 'xc-token': env.NOCODB_API_TOKEN }
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Failed to fetch from NocoDB: ${response.status} - ${response.statusText} - ${errorBody}`);
    }

    const data = await response.json();
    return data.list; // Assuming the NocoDB API returns an object with a 'list' property
}

// --- API Endpoint Implementations ---

async function fetchAllCertifications(request, env, headers) {
    const allCertifications = await fetchFromNocoDB(env, CERTIFICATIONS_TABLE_ID, { limit: 10000 }); // Fetch a large enough limit or implement pagination
    return new Response(JSON.stringify(allCertifications), { headers });
}

async function getCertificationsSummary(request, env, headers) {
    const allCertifications = await fetchFromNocoDB(env, CERTIFICATIONS_TABLE_ID, { limit: 10000 });

    const summary = {
        total: allCertifications.length,
        byCredential: {},
        byCounty: {},
        byCity: {}
    };

    allCertifications.forEach(cert => {
        const credential = cert.CREDENTIAL || 'Unknown';
        const county = cert.COUNTY || 'Unknown';
        const city = cert.CITY || 'Unknown';

        summary.byCredential[credential] = (summary.byCredential[credential] || 0) + 1;
        summary.byCounty[county] = (summary.byCounty[county] || 0) + 1;
        summary.byCity[city] = (summary.byCity[city] || 0) + 1;
    });

    return new Response(JSON.stringify(summary), { headers });
}

async function getMonthlyTrends(request, env, headers) {
    const allCertifications = await fetchFromNocoDB(env, CERTIFICATIONS_TABLE_ID, { limit: 10000 });

    const monthlyData = {}; // Format: { 'YYYY-MM': { newlyCertified: { CRS: X, CFRS: Y }, lapsed: Z, expired: A, ethicsViolations: B } }

    const getMonthEntry = (dateStr) => {
        if (!dateStr) return null;
        return dateStr.substring(0, 7); // YYYY-MM
    };

    allCertifications.forEach(cert => {
        const issueDate = cert['ISSUE DATE'];
        const expDate = cert['EXP DATE'];
        const status = cert.STATUS;
        const credential = cert.CREDENTIAL || 'Unknown';

        // Monthly New Certifications
        const issueMonth = getMonthEntry(issueDate);
        if (issueMonth) {
            if (!monthlyData[issueMonth]) monthlyData[issueMonth] = { newlyCertified: {}, lapsed: 0, expired: 0, ethicsViolations: 0 };
            if (!monthlyData[issueMonth].newlyCertified[credential]) monthlyData[issueMonth].newlyCertified[credential] = 0;
            monthlyData[issueMonth].newlyCertified[credential]++;
        }

        // Monthly Lapsed/Expired (simplified logic - adjust based on your exact definitions)
        const expirationMonth = getMonthEntry(expDate);
        if (expirationMonth) {
             if (!monthlyData[expirationMonth]) monthlyData[expirationMonth] = { newlyCertified: {}, lapsed: 0, expired: 0, ethicsViolations: 0 };

            const today = new Date();
            const expDt = new Date(expDate);

            // Check if expired in this month
            if (expDt.getFullYear() === today.getFullYear() && expDt.getMonth() === today.getMonth()) {
                if (status !== 'Active') { // Assuming 'Active' means not expired/lapsed
                    monthlyData[expirationMonth].expired++;
                }
            }

            // Check if lapsed in this month (based on status field)
             if (status && status.toLowerCase().includes('lapsed')) {
                 if (!monthlyData[expirationMonth]) monthlyData[expirationMonth] = { newlyCertified: {}, lapsed: 0, expired: 0, ethicsViolations: 0 };
                 monthlyData[expirationMonth].lapsed++;
             }
        }

        // Ethics Violations (assuming a specific status or field marks this)
        if (status && status.toLowerCase().includes('ethics')) { // Adjust based on your actual data
            const violationMonth = issueMonth || getMonthEntry(new Date().toISOString()); // Tie to issue date or current month
            if (!monthlyData[violationMonth]) monthlyData[violationMonth] = { newlyCertified: {}, lapsed: 0, expired: 0, ethicsViolations: 0 };
            monthlyData[violationMonth].ethicsViolations++;
        }
    });

    // Sort monthly data by date
    const sortedMonths = Object.keys(monthlyData).sort();
    const formattedMonthlyData = {};
    sortedMonths.forEach(month => {
        formattedMonthlyData[month] = monthlyData[month];
    });

    return new Response(JSON.stringify(formattedMonthlyData), { headers });
}

async function getTableData(request, env, headers) {
    const urlParams = new URLSearchParams(url.search);

    // DataTables server-side processing parameters
    const draw = urlParams.get('draw'); // DataTables draw counter
    const start = parseInt(urlParams.get('start') || '0'); // Start record index
    const length = parseInt(urlParams.get('length') || '10'); // Number of records to display
    const searchValue = urlParams.get('search[value]') || ''; // Global search value
    const orderColumnIndex = urlParams.get('order[0][column]');
    const orderDirection = urlParams.get('order[0][dir]');

    // Fetch all data for now. For very large datasets,
    // you'd pass limit/offset/where/sort directly to NocoDB via `fetchFromNocoDB`.
    const allCertifications = await fetchFromNocoDB(env, CERTIFICATIONS_TABLE_ID, { limit: 10000 }); // Adjust limit as needed

    let filteredData = allCertifications;

    // Apply global search filter
    if (searchValue) {
        filteredData = allCertifications.filter(cert =>
            Object.values(cert).some(value =>
                String(value).toLowerCase().includes(searchValue.toLowerCase())
            )
        );
    }

    // Apply sorting
    if (orderColumnIndex !== null && orderDirection) {
        // These column names must match the 'data' property of your DataTables column definitions
        const columns = ['Id', 'SCRAPE ORDER', 'NAME', 'CITY', 'CREDENTIAL', 'NUMBER', 'ISSUE DATE', 'EXP DATE', 'STATUS', 'COUNTY', 'REGION'];
        const sortColumnName = columns[orderColumnIndex];

        if (sortColumnName) {
            filteredData.sort((a, b) => {
                const valA = String(a[sortColumnName] || '').toLowerCase();
                const valB = String(b[sortColumnName] || '').toLowerCase();

                if (valA < valB) return orderDirection === 'asc' ? -1 : 1;
                if (valA > valB) return orderDirection === 'asc' ? 1 : -1;
                return 0;
            });
        }
    }

    const totalRecords = allCertifications.length;
    const recordsFiltered = filteredData.length;

    // Apply pagination
    const paginatedData = filteredData.slice(start, start + length);

    const responseData = {
        draw: draw,
        recordsTotal: totalRecords,
        recordsFiltered: recordsFiltered,
        data: paginatedData
    };

    return new Response(JSON.stringify(responseData), { headers });
}

// Helper to determine Content-Type for static files (less critical if [site] binding handles it directly)
function getContentType(pathname) {
    if (pathname.endsWith('.html')) return 'text/html';
    if (pathname.endsWith('.css')) return 'text/css';
    if (pathname.endsWith('.js')) return 'application/javascript';
    if (pathname.endsWith('.json')) return 'application/json';
    if (pathname.endsWith('.png')) return 'image/png';
    if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
    if (pathname.endsWith('.gif')) return 'image/gif';
    if (pathname.endsWith('.svg')) return 'image/svg+xml';
    return 'application/octet-stream'; // Default
}