/* MakeMovie product page: language listbox, copy buttons, scroll reveal. */
(function () {
  'use strict'

  var nav = document.querySelector('header.nav')
  if (nav) {
    var pin = function () { nav.classList.toggle('pinned', window.scrollY > 8) }
    pin()
    window.addEventListener('scroll', pin, { passive: true })
  }

  // Language listbox: two static entries, current one ticked.
  var lang = document.querySelector('.lang')
  if (lang) {
    var btn = lang.querySelector('.lang-btn')
    var menu = lang.querySelector('.lang-menu')
    var options = Array.prototype.slice.call(menu.querySelectorAll('[role="option"]'))

    function open(state) {
      lang.setAttribute('aria-open', state ? 'true' : 'false')
      btn.setAttribute('aria-expanded', state ? 'true' : 'false')
      if (state) options[0].focus()
    }
    btn.addEventListener('click', function (e) {
      e.stopPropagation()
      open(lang.getAttribute('aria-open') !== 'true')
    })
    document.addEventListener('click', function (e) {
      if (lang.getAttribute('aria-open') === 'true' && !lang.contains(e.target)) open(false)
    })
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && lang.getAttribute('aria-open') === 'true') {
        open(false)
        btn.focus()
      }
    })
    menu.addEventListener('keydown', function (e) {
      var i = options.indexOf(document.activeElement)
      if (i < 0) return
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        options[(i + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length].focus()
      }
    })
  }

  // Copy buttons: clipboard with a textarea fallback for file:// and older browsers.
  document.addEventListener('click', function (e) {
    var copy = e.target.closest('.copy')
    if (!copy) return
    var block = copy.parentNode.querySelector('code')
    if (!block) return
    var text = block.innerText
    function done() {
      copy.setAttribute('data-copied', 'true')
      window.setTimeout(function () { copy.removeAttribute('data-copied') }, 1800)
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, function () { legacy(text, done) })
    } else {
      legacy(text, done)
    }
  })

  function legacy(text, done) {
    var ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.cssText = 'position:fixed;left:-9999px;top:0'
    document.body.appendChild(ta)
    ta.select()
    try {
      document.execCommand('copy')
      done()
    } catch (err) {
      /* nothing selected: leave the button as-is rather than claiming success */
    }
    document.body.removeChild(ta)
  }

  var reveal = Array.prototype.slice.call(document.querySelectorAll('.reveal'))
  if (!window.IntersectionObserver || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    reveal.forEach(function (el) { el.classList.add('in') })
  } else {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) {
            en.target.classList.add('in')
            io.unobserve(en.target)
          }
        })
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 }
    )
    reveal.forEach(function (el) { io.observe(el) })
  }
})()
