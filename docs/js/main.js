// Configuration
const CONFIG = {
    SERVER_URL: 'https://cinecalidad-stremio-addon.reliutg.workers.dev',
    MANIFEST_PATH: '/manifest.json'
};

// Status checking
async function checkServerStatus() {
    const statusElement = document.getElementById('serverStatus');
    if (!statusElement) return;

    try {
        statusElement.className = 'status-indicator checking';
        statusElement.textContent = 'Verificando estado...';

        const response = await fetch(`${CONFIG.SERVER_URL}${CONFIG.MANIFEST_PATH}`, {
            method: 'HEAD',
            cache: 'no-cache'
        });

        if (response.ok) {
            statusElement.className = 'status-indicator online';
            statusElement.textContent = 'Servidor Online';
        } else {
            statusElement.className = 'status-indicator offline';
            statusElement.textContent = 'Servidor Offline';
        }
    } catch (error) {
        statusElement.className = 'status-indicator offline';
        statusElement.textContent = 'Servidor Offline';
    }
}

// Copy manifest URL to clipboard
async function copyManifestUrl() {
    const manifestUrl = `${CONFIG.SERVER_URL}${CONFIG.MANIFEST_PATH}`;
    
    try {
        await navigator.clipboard.writeText(manifestUrl);
        showToast('✅ URL del manifest copiada al portapapeles!');
    } catch (err) {
        // Fallback for older browsers
        const textArea = document.createElement('textarea');
        textArea.value = manifestUrl;
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        try {
            document.execCommand('copy');
            showToast('✅ URL del manifest copiada al portapapeles!');
        } catch (err) {
            showToast('❌ No se pudo copiar la URL');
        }
        document.body.removeChild(textArea);
    }
}

// Show toast notification
function showToast(message, duration = 3000) {
    const toast = document.getElementById('toast');
    const toastMessage = document.getElementById('toastMessage');
    
    if (!toast || !toastMessage) return;
    
    toastMessage.textContent = message;
    toast.classList.add('show');
    
    setTimeout(() => {
        hideToast();
    }, duration);
}

// Hide toast notification
function hideToast() {
    const toast = document.getElementById('toast');
    if (toast) {
        toast.classList.remove('show');
    }
}

// Add smooth scroll behavior
function smoothScrollTo(element, duration = 800) {
    const targetPosition = element.offsetTop;
    const startPosition = window.pageYOffset;
    const distance = targetPosition - startPosition;
    let startTime = null;

    function animation(currentTime) {
        if (startTime === null) startTime = currentTime;
        const timeElapsed = currentTime - startTime;
        const run = ease(timeElapsed, startPosition, distance, duration);
        window.scrollTo(0, run);
        if (timeElapsed < duration) requestAnimationFrame(animation);
    }

    function ease(t, b, c, d) {
        t /= d / 2;
        if (t < 1) return c / 2 * t * t + b;
        t--;
        return -c / 2 * (t * (t - 2) - 1) + b;
    }

    requestAnimationFrame(animation);
}

// Add ripple effect to buttons
function addRippleEffect(e) {
    const button = e.currentTarget;
    const ripple = document.createElement('span');
    const rect = button.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const x = e.clientX - rect.left - size / 2;
    const y = e.clientY - rect.top - size / 2;
    
    ripple.style.cssText = `
        position: absolute;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.5);
        transform: scale(0);
        animation: ripple-effect 0.6s linear;
        width: ${size}px;
        height: ${size}px;
        left: ${x}px;
        top: ${y}px;
        pointer-events: none;
    `;
    
    const style = document.createElement('style');
    style.textContent = `
        @keyframes ripple-effect {
            to {
                transform: scale(2);
                opacity: 0;
            }
        }
    `;
    document.head.appendChild(style);
    
    button.style.position = 'relative';
    button.style.overflow = 'hidden';
    button.appendChild(ripple);
    
    setTimeout(() => {
        ripple.remove();
    }, 600);
}

// Initialize app
document.addEventListener('DOMContentLoaded', function() {
    // Set current year
    const yearElement = document.getElementById('currentYear');
    if (yearElement) {
        yearElement.textContent = new Date().getFullYear();
    }
    
    // Check server status immediately and every 30 seconds
    checkServerStatus();
    setInterval(checkServerStatus, 30000);
    
    // Add ripple effect to buttons
    const buttons = document.querySelectorAll('.install-btn');
    buttons.forEach(button => {
        button.addEventListener('click', addRippleEffect);
    });
});
