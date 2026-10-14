import {ExternalLink} from 'lucide-react'

export default function OpenInAtmos({id,version='draft',theme='light'}) {
  const query=new URLSearchParams({id,version,theme})
  return <a className="icon-button" href={`/inspection/?${query}`} target="_blank" rel="noopener noreferrer" title="Open in Atmos" aria-label="Open in Atmos"><ExternalLink size={16}/></a>
}
