function getToken(){return localStorage.getItem('tiffin_token')}
function setToken(token){localStorage.setItem('tiffin_token',token)}
function logout(){localStorage.removeItem('tiffin_token');window.location.href='/login.html'}
async function apiFetch(url,options={}){
  const token=getToken();
  const headers=Object.assign({'Content-Type':'application/json'},options.headers||{},token?{Authorization:`Bearer ${token}`}:{})
  const res=await fetch(url,{...options,headers});
  if(res.status===401){logout();throw new Error('Your session expired. Please log in again.')}
  return res
}
function requireLoggedIn(){if(!getToken())window.location.href='/login.html'}
async function downloadFile(url,filename){const res=await apiFetch(url);if(!res.ok){const d=await res.json().catch(()=>({}));throw new Error(d.error||'download failed')}const blob=await res.blob();const href=URL.createObjectURL(blob);const link=document.createElement('a');link.href=href;link.download=filename;document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(href),500)}
function toast(message,type='success'){const stack=document.getElementById('toastStack');if(!stack)return;const el=document.createElement('div');el.className=`toast ${type==='error'?'error':''}`;el.textContent=message;stack.appendChild(el);setTimeout(()=>el.remove(),4200)}
function openModal(id){document.getElementById(id).classList.remove('hidden')}
function closeModal(id){document.getElementById(id).classList.add('hidden')}
document.addEventListener('click',e=>{const close=e.target.closest('[data-close-modal]');if(close)closeModal(close.dataset.closeModal);if(e.target.classList.contains('modal-backdrop'))closeModal(e.target.id)})
